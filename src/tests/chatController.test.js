const httpMocks = require('node-mocks-http');
const { getMessages, sendMessage, deleteMessage } = require('../controllers/chatController');

// ─── 1. MOCK SUPABASE CLIENT ─────────────────────────────────────────────────

// Define the mock inside the factory to prevent hoisting errors
jest.mock('../supabaseClient', () => {
  return {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    single: jest.fn()
  };
});

const mockSupabase = require('../supabaseClient');

// ─── 2. TEST SUITE ───────────────────────────────────────────────────────────

describe('Chat Controller', () => {
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();

    req = httpMocks.createRequest({
      user: { id: 'user-123', role: 'employee' },
      body: {},
      query: {},
      params: {}
    });
    res = httpMocks.createResponse();
  });

  // ─── GET MESSAGES TESTS ────────────────────────────────────────────────────

  describe('getMessages', () => {
    it('should fetch messages with default pagination and scrub deleted text', async () => {
      // Mock the database returning two messages (one normal, one deleted)
      mockSupabase.range.mockResolvedValueOnce({
        data: [
          { id: 'msg-1', text: 'Hello team', is_deleted: false, user_id: 'user-123' },
          { id: 'msg-2', text: 'Secret info', is_deleted: true, user_id: 'user-456' }
        ],
        count: 2
      });

      await getMessages(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.total).toBe(2);
      expect(response.page).toBe(1); // Default page
      expect(response.limit).toBe(50); // Default limit
      
      // Verify the server-side scrubbing logic worked securely
      expect(response.messages[0].text).toBe('Hello team');
      expect(response.messages[1].text).toBe('This message was deleted');
    });

    it('should handle custom pagination parameters', async () => {
      req.query = { page: '2', limit: '10' };
      mockSupabase.range.mockResolvedValueOnce({ data: [], count: 0 });

      await getMessages(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.page).toBe(2);
      expect(response.limit).toBe(10);
      
      // Offset math: (2 - 1) * 10 = 10. Range should be 10 to 19.
      expect(mockSupabase.range).toHaveBeenCalledWith(10, 19);
    });

    it('should return 500 if database query fails', async () => {
      mockSupabase.range.mockResolvedValueOnce({ error: { message: 'DB Error' } });

      await getMessages(req, res);
      expect(res.statusCode).toBe(500);
      expect(res._getJSONData().error).toBe('Failed to fetch messages.');
    });
  });

  // ─── SEND MESSAGE TESTS ────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('should fail with 400 if text is missing or empty whitespace', async () => {
      req.body = { text: '   ' };

      await sendMessage(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().error).toBe('Message text is required.');
    });

    it('should successfully send a message and trim whitespace', async () => {
      req.body = { text: '  Hello world  ' };
      
      mockSupabase.single.mockResolvedValueOnce({
        data: { id: 'msg-new', text: 'Hello world', user_id: 'user-123' }
      });

      await sendMessage(req, res);
      
      expect(res.statusCode).toBe(201);
      expect(res._getJSONData().message.text).toBe('Hello world');
      
      // Verify it was inserted with trimmed text
      expect(mockSupabase.insert).toHaveBeenCalledWith({
        user_id: 'user-123',
        text: 'Hello world'
      });
    });

    it('should return 500 if insert fails', async () => {
      req.body = { text: 'Valid text' };
      mockSupabase.single.mockResolvedValueOnce({ error: { message: 'Insert failed' } });

      await sendMessage(req, res);
      expect(res.statusCode).toBe(500);
    });
  });

  // ─── DELETE MESSAGE TESTS ──────────────────────────────────────────────────

  // ─── DELETE MESSAGE TESTS ──────────────────────────────────────────────────

  describe('deleteMessage', () => {
    it('should fail with 404 if message does not exist', async () => {
      req.params = { id: 'missing-msg' };
      
      // Let the first .eq() chain normally
      mockSupabase.eq.mockReturnValueOnce(mockSupabase);
      mockSupabase.single.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } });

      await deleteMessage(req, res);
      expect(res.statusCode).toBe(404);
      expect(res._getJSONData().error).toBe('Message not found.');
    });

    it('should fail with 403 if an employee tries to delete someone elses message', async () => {
      req.params = { id: 'msg-456' };
      req.user.role = 'employee';
      
      mockSupabase.eq.mockReturnValueOnce(mockSupabase);
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'msg-456', user_id: 'other-user-uuid' } });

      await deleteMessage(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData().error).toBe('You can only delete your own messages.');
    });

    it('should allow an employee to delete their own message', async () => {
      req.params = { id: 'my-msg' };
      req.user.role = 'employee';
      req.user.id = 'user-123';
      
      // Call 1: .eq() for the select query (passes through)
      // Call 2: .eq() for the update query (resolves)
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)
        .mockResolvedValueOnce({ error: null });

      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'my-msg', user_id: 'user-123' } });

      await deleteMessage(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().message).toBe('Message deleted.');
      
      // Verify we passed is_deleted: true to the database
      expect(mockSupabase.update).toHaveBeenCalledWith({ is_deleted: true });
    });

    it('should allow an admin or CEO to delete ANY message', async () => {
      req.params = { id: 'other-users-msg' };
      req.user.role = 'admin'; // Admin override
      
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)
        .mockResolvedValueOnce({ error: null });

      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'other-users-msg', user_id: 'target-user-uuid' } });

      await deleteMessage(req, res);
      expect(res.statusCode).toBe(200);
    });

    it('should return 500 if the delete update fails', async () => {
      req.params = { id: 'my-msg' };
      
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase)
        .mockResolvedValueOnce({ error: { message: 'Update failed' } });

      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'my-msg', user_id: 'user-123' } });

      await deleteMessage(req, res);
      expect(res.statusCode).toBe(500);
    });
  });
});