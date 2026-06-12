const httpMocks = require('node-mocks-http');
const { 
  login, logout, me, 
  resetPassword, forgotPassword, confirmReset 
} = require('../controllers/authController');

// ─── 1. UNIVERSAL SUPABASE MOCK ──────────────────────────────────────────────

// Define the mock completely inside the factory to prevent hoisting crashes
jest.mock('../supabaseClient', () => {
  return {
    auth: {
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
      resetPasswordForEmail: jest.fn(),
      getUser: jest.fn(),
      admin: { updateUserById: jest.fn() }
    },
    from: jest.fn()
  };
});

// Require the mocked client and extract the auth piece for our tests
const mockSupabase = require('../supabaseClient');
const mockAuth = mockSupabase.auth;



// Helper function to create an object that Javascript "await" treats as a Promise.
const buildDbChain = () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    // 'then' makes this object awaitable! Default resolves to empty data.
    then: jest.fn((resolve) => resolve({ data: null, error: null, count: 0 }))
  };
  return chain;
};

// ─── 2. TEST SUITE ───────────────────────────────────────────────────────────

describe('Auth Controller', () => {
  let req, res;
  let usersChain, attTodayChain, attMonthChain, notifChain, leavesChain;

  beforeEach(() => {
    jest.clearAllMocks();

    req = httpMocks.createRequest({
      user: { id: 'test-uuid-123', name: 'Test Employee' },
      body: {}
    });
    res = httpMocks.createResponse();

    // Create fresh chains for every test
    usersChain    = buildDbChain();
    attTodayChain = buildDbChain();
    attMonthChain = buildDbChain();
    notifChain    = buildDbChain();
    leavesChain   = buildDbChain();

    // Route the 'from()' calls to the correct isolated chain
    mockSupabase.from.mockImplementation((table) => {
      if (table === 'users') return usersChain;
      if (table === 'notifications') return notifChain;
      if (table === 'leaves') return leavesChain;
      if (table === 'attendance') {
        return {
          select: jest.fn((fields) => {
            // Route to specific attendance chain based on the select fields
            if (fields === '*') return attTodayChain;
            return attMonthChain;
          })
        };
      }
      return buildDbChain();
    });
  });

  // ─── LOGIN TESTS ───────────────────────────────────────────────────────────

  describe('login', () => {
    it('should fail with 400 if email or password is missing', async () => {
      req.body = { email: 'test@test.com' }; // missing pwd
      await login(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().error).toBe('Email and password are required.');
    });

    it('should fail with 401 on invalid Supabase credentials', async () => {
      req.body = { email: 'test@test.com', password: 'wrong' };
      mockAuth.signInWithPassword.mockResolvedValueOnce({ error: { message: 'Invalid login' } });

      await login(req, res);
      expect(res.statusCode).toBe(401);
    });

    it('should fail with 401 if user profile is inactive or not found', async () => {
      req.body = { email: 'test@test.com', password: 'password' };
      mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: '123' }, session: {} } });
      
      // Resolve the profile query with no data
      usersChain.then.mockImplementationOnce(cb => cb({ data: null }));

      await login(req, res);
      expect(res.statusCode).toBe(401);
      expect(res._getJSONData().error).toBe('Account not found or deactivated.');
    });

    it('should return 200 with forceReset flag if must_reset_password is true', async () => {
      req.body = { email: 'test@test.com', password: 'password' };
      mockAuth.signInWithPassword.mockResolvedValueOnce({ data: { user: { id: '123' }, session: { access_token: 'token' } } });
      
      // Resolve with must_reset_password: true
      usersChain.then.mockImplementationOnce(cb => cb({ data: { id: '123', must_reset_password: true } }));

      await login(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().forceReset).toBe(true);
    });

    it('should successfully login and fetch all bootstrap data concurrently', async () => {
      req.body = { email: 'test@test.com', password: 'password' };
      
      mockAuth.signInWithPassword.mockResolvedValueOnce({ 
        data: { user: { id: '123' }, session: { access_token: 'token123' } } 
      });

      // 1. Profile Query
      usersChain.then.mockImplementationOnce(cb => cb({ data: { id: '123', must_reset_password: false } }));
      
      // 2. Bootstrap Queries (Promise.allSettled)
      attTodayChain.then.mockImplementationOnce(cb => cb({ data: { status: 'present' } }));
      attMonthChain.then.mockImplementationOnce(cb => cb({ data: [
        { normal_hours: 8, status: 'present' }, { normal_hours: 8, status: 'present' }
      ] }));
      notifChain.then.mockImplementationOnce(cb => cb({ count: 5 }));
      leavesChain.then.mockImplementationOnce(cb => cb({ count: 2 }));

      await login(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.access_token).toBe('token123');
      expect(response.bootstrap.today_attendance.status).toBe('present');
      expect(response.bootstrap.unread_notifs).toBe(5);
      expect(response.bootstrap.pending_leaves).toBe(2);
      expect(response.bootstrap.monthly_summary.present_days).toBe(2);
      expect(response.bootstrap.monthly_summary.normal_hours).toBe(16);
    });
  });

  // ─── LOGOUT & ME ───────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should call signOut and return 200', async () => {
      mockAuth.signOut.mockResolvedValueOnce({});
      await logout(req, res);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('me', () => {
    it('should return the current req.user', async () => {
      await me(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().user.id).toBe('test-uuid-123');
    });
  });

  // ─── PASSWORD MANAGEMENT ───────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('should fail with 400 if password is less than 8 characters', async () => {
      req.body = { new_password: 'short' };
      await resetPassword(req, res);
      expect(res.statusCode).toBe(400);
    });

    it('should successfully update password and clear reset flag', async () => {
      req.body = { new_password: 'NewSecurePassword123!' };
      
      mockAuth.admin.updateUserById.mockResolvedValueOnce({ error: null });
      // The update query for the user chain will naturally resolve due to our universal builder
      usersChain.then.mockImplementationOnce(cb => cb({ error: null }));

      await resetPassword(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().message).toBe('Password updated successfully.');
      expect(mockAuth.admin.updateUserById).toHaveBeenCalledWith('test-uuid-123', { password: 'NewSecurePassword123!' });
    });
  });

  describe('forgotPassword', () => {
    it('should fail with 400 if email is missing', async () => {
      req.body = {};
      await forgotPassword(req, res);
      expect(res.statusCode).toBe(400);
    });

    it('should trigger reset email and return 200', async () => {
      req.body = { email: '  User@test.com  ' };
      mockAuth.resetPasswordForEmail.mockResolvedValueOnce({ error: null });

      await forgotPassword(req, res);
      expect(res.statusCode).toBe(200);
      
      // Should trim and convert to lowercase automatically
      expect(mockAuth.resetPasswordForEmail).toHaveBeenCalledWith('user@test.com', expect.any(Object));
    });
  });

  describe('confirmReset', () => {
    it('should fail with 400 if token or password missing', async () => {
      req.body = { access_token: 'token' }; // missing pwd
      await confirmReset(req, res);
      expect(res.statusCode).toBe(400);
    });

    it('should fail with 401 if the access token is invalid', async () => {
      req.body = { access_token: 'bad-token', new_password: 'ValidPassword123!' };
      mockAuth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Expired' } });

      await confirmReset(req, res);
      expect(res.statusCode).toBe(401);
    });

    it('should successfully update password and clear reset flag', async () => {
      req.body = { access_token: 'good-token', new_password: 'ValidPassword123!' };
      
      mockAuth.getUser.mockResolvedValueOnce({ data: { user: { id: 'recovered-uuid' } } });
      mockAuth.admin.updateUserById.mockResolvedValueOnce({ error: null });
      usersChain.then.mockImplementationOnce(cb => cb({ error: null }));

      await confirmReset(req, res);
      expect(res.statusCode).toBe(200);
      expect(mockAuth.admin.updateUserById).toHaveBeenCalledWith('recovered-uuid', { password: 'ValidPassword123!' });
    });
  });
});