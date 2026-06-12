const httpMocks = require('node-mocks-http');
const { checkIn, checkOut } = require('../controllers/attendanceController');

// 1. Mock the Supabase Client DIRECTLY inside the factory to avoid hoisting errors
// 1. Mock the Supabase Client DIRECTLY inside the factory
jest.mock('../supabaseClient', () => {
  return {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn()
  };
});

// Now require it so we can spy on it and change return values in our tests
const mockSupabase = require('../supabaseClient');

// 2. Mock the Hours Service
jest.mock('../services/hoursService', () => ({
  calculateHours: jest.fn(),
  sumBreakMinutes: jest.fn(),
  sumMonthlyTotals: jest.fn()
}));

const hoursService = require('../services/hoursService');



describe('Attendance Controller', () => {
  let req, res;

  // Valid coordinates from your controller (Pakkar Tanver Export)
  const VALID_LAT = 13.104026;
  const VALID_LNG = 80.250346;

  beforeEach(() => {
    // Clear all mocks before each test so they don't leak into one another
    jest.clearAllMocks();

    // Create fresh fake Request and Response objects
    req = httpMocks.createRequest({
      user: { id: 'test-uuid-123', name: 'Test Employee' },
      body: {}
    });
    res = httpMocks.createResponse();
  });

  // ─── CHECK IN TESTS ────────────────────────────────────────────────────────

  describe('checkIn', () => {
    it('should fail with 403 if user is outside the 100m geofence', async () => {
      req.body = {
        lat: 40.7128, // New York (definitely > 100m from Chennai)
        lng: -74.0060,
        photo_url: 'https://ik.imagekit.io/test.jpg'
      };

      await checkIn(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(403);
      expect(response.error).toMatch(/Check-in is only allowed within 100 m/);
    });

    it('should fail with 400 if photo_url is missing', async () => {
      req.body = { lat: VALID_LAT, lng: VALID_LNG }; // Missing photo

      await checkIn(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(400);
      expect(response.error).toBe('A valid photo_url is required. Upload the photo to ImageKit first.');
    });

    it('should fail with 409 if user is already checked in today', async () => {
      req.body = { lat: VALID_LAT, lng: VALID_LNG, photo_url: 'https://valid.url' };
      
      // Simulate Supabase finding an existing record
      mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'existing-id' } });

      await checkIn(req, res);
      
      expect(res.statusCode).toBe(409);
      expect(res._getJSONData().error).toBe('Already checked in today.');
    });

    it('should successfully check in a user with valid data', async () => {
      req.body = { lat: VALID_LAT, lng: VALID_LNG, photo_url: 'https://valid.url' };
      
      // Simulate Supabase NOT finding an existing record
      mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null });
      // Simulate Supabase successfully inserting the new record
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'new-record-id', status: 'present' } });

      await checkIn(req, res);

      expect(res.statusCode).toBe(201);
      expect(res._getJSONData().message).toBe('Checked in successfully.');
      expect(mockSupabase.insert).toHaveBeenCalled(); // Verify insert was called
    });
  });

  // ─── CHECK OUT TESTS ───────────────────────────────────────────────────────

  describe('checkOut', () => {
    it('should fail with 400 if no check-in record exists for today', async () => {
      req.body = { lat: VALID_LAT, lng: VALID_LNG, photo_url: 'https://valid.url' };
      
      // Simulate Supabase finding NO check-in record
      mockSupabase.single.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } });

      await checkOut(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().error).toBe('No check-in record found for today.');
    });

    it('should successfully check out, auto-close breaks, and calculate hours', async () => {
      req.body = { lat: VALID_LAT, lng: VALID_LNG, photo_url: 'https://valid.url' };
      
      // 1. Mock finding the check-in record
      mockSupabase.single.mockResolvedValueOnce({ 
        data: { id: 'record-123', check_in_time: '2026-06-12T09:00:00Z', check_out_time: null } 
      });
      
      // 2. Mock finding an open break (so it auto-closes it)
      mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'open-break-id' } });
      
      // 3. Mock fetching the total breaks for the day
      mockSupabase.not.mockResolvedValueOnce({ data: [{ break_start: '10:00', break_end: '10:30' }] });
      
      // Mock the hours service math
      hoursService.sumBreakMinutes.mockReturnValue(30);
      hoursService.calculateHours.mockReturnValue({
        raw_hours: 8.5, normal_hours: 8.5, overtime_hours: 0, total_hours: 8.5
      });

      // 4. Mock the final update returning the updated record
      mockSupabase.single.mockResolvedValueOnce({ 
        data: { id: 'record-123', total_hours: 8.5 } 
      });

      await checkOut(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().message).toBe('Checked out successfully.');
      
      // Verify our external service was called with the summed break minutes
      expect(hoursService.calculateHours).toHaveBeenCalledWith(
        '2026-06-12T09:00:00Z',
        expect.any(String), // checkOutTime generated inside the function
        30
      );
    });
  });
  // ─── BREAK MANAGEMENT TESTS ────────────────────────────────────────────────

  describe('startBreak', () => {
    const { startBreak } = require('../controllers/attendanceController');

    it('should fail with 400 if user has not checked in today', async () => {
      mockSupabase.single.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } });
      await startBreak(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().error).toBe('No check-in record found for today.');
    });

    it('should fail with 409 if a break is already in progress', async () => {
      // Mock existing attendance record
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123', check_out_time: null } });
      // Mock finding an open break
      mockSupabase.maybeSingle.mockResolvedValueOnce({ data: { id: 'break-123' } });

      await startBreak(req, res);
      expect(res.statusCode).toBe(409);
      expect(res._getJSONData().error).toBe('A break is already in progress.');
    });

    it('should successfully start a break', async () => {
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123', check_out_time: null } });
      mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null }); // No open break
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'new-break-id' } }); // Insert success

      await startBreak(req, res);
      expect(res.statusCode).toBe(201);
      expect(res._getJSONData().message).toBe('Break started.');
    });
  });

  describe('endBreak', () => {
    const { endBreak } = require('../controllers/attendanceController');

    it('should fail with 400 if no active break is found', async () => {
      // Mock attendance record
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123' } });
      // Mock NO active break
      mockSupabase.single.mockResolvedValueOnce({ data: null, error: { message: 'No break' } });

      await endBreak(req, res);
      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().error).toBe('No active break found.');
    });

    it('should successfully end a break and update total break minutes', async () => {
      // 1. Mock attendance record
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123', check_in_time: '09:00', check_out_time: null } });
      // 2. Mock active break found
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'break-123' } });
      // 3. Mock closing the break (update)
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'break-123', break_end: '10:00' } });
      // 4. Mock fetching all breaks to sum them
      mockSupabase.not.mockResolvedValueOnce({ data: [{ break_start: '09:30', break_end: '10:00' }] });
      // 5. Mock final attendance update
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123', break_minutes: 30 } });

      hoursService.sumBreakMinutes.mockReturnValue(30);

      await endBreak(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().message).toBe('Break ended.');
    });
  });

  // ─── GET AND REPORT TESTS ──────────────────────────────────────────────────

  describe('getToday', () => {
    const { getToday } = require('../controllers/attendanceController');

    it('should return today attendance with parsed open break times', async () => {
      mockSupabase.maybeSingle.mockResolvedValueOnce({
        data: { 
          id: 'att-123', 
          breaks: [{ break_start: '10:00', break_end: null }] // Open break
        }
      });

      await getToday(req, res);
      const response = res._getJSONData();
      
      expect(res.statusCode).toBe(200);
      expect(response.attendance.break_start_time).toBe('10:00');
      expect(response.attendance.break_end_time).toBeNull();
    });
  });

  describe('getMonthlySummary', () => {
    const { getMonthlySummary } = require('../controllers/attendanceController');

    it('should fail with 403 if an employee requests another users summary', async () => {
      req.user.role = 'employee';
      req.query.user_id = 'some-other-uuid';

      await getMonthlySummary(req, res);
      expect(res.statusCode).toBe(403);
      expect(res._getJSONData().error).toBe('Access denied.');
    });

    it('should return monthly summary for valid user', async () => {
      req.user.role = 'admin';
      req.query.user_id = 'any-uuid';
      req.query.month = '2026-06';

      mockSupabase.lte.mockResolvedValueOnce({ data: [{ normal_hours: 8 }] });
      hoursService.sumMonthlyTotals.mockReturnValue({ total_hours: 160 });

      await getMonthlySummary(req, res);
      expect(res.statusCode).toBe(200);
      expect(res._getJSONData().summary.total_hours).toBe(160);
    });
  });

  describe('getHistory', () => {
    const { getHistory } = require('../controllers/attendanceController');

    it('should return paginated history records', async () => {
      mockSupabase.range.mockResolvedValueOnce({ data: [{ id: 'att-1' }, { id: 'att-2' }], count: 2 });

      await getHistory(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.records.length).toBe(2);
      expect(response.total).toBe(2);
    });
  });

  // ─── ADMIN SPECIFIC TESTS ──────────────────────────────────────────────────

  describe('getAllToday (Admin)', () => {
    const { getAllToday } = require('../controllers/attendanceController');

    it('should map employees to their attendance records', async () => {
      // Query 1 ends in .order(), so we resolve the employees here.
      mockSupabase.order.mockResolvedValueOnce({ data: [{ id: 'emp-1', name: 'John' }] });

      // Handle the .eq() chain safely!
      // Call 1 & 2 belong to the employee query. Call 3 belongs to the attendance query.
      mockSupabase.eq
        .mockReturnValueOnce(mockSupabase) // Query 1: eq('is_active', true)
        .mockReturnValueOnce(mockSupabase) // Query 1: eq('role', 'employee')
        .mockResolvedValueOnce({ data: [{ user_id: 'emp-1', status: 'present' }] }); // Query 2: eq('date', ...)

      await getAllToday(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.employees[0].name).toBe('John');
      expect(response.employees[0].today.status).toBe('present');
    });
  });

describe('getReport (Admin)', () => {
    const { getReport } = require('../controllers/attendanceController');

    it('should fetch the monthly report for all users', async () => {
      req.query = { month: '2026-06' };

      // The controller calls .from().select().gte().lte().order()
      // Since no user_id is provided, .order() is the final method in the chain
      mockSupabase.order.mockResolvedValueOnce({ 
        data: [{ id: 'att-1', users: { name: 'Jane Doe' } }] 
      });

      await getReport(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.records[0].users.name).toBe('Jane Doe');
      expect(response.month).toBe('2026-06');
    });

    it('should filter the report by user_id if provided', async () => {
      req.query = { month: '2026-06', user_id: 'specific-uuid-123' };

      // If user_id is provided, the controller appends .eq('user_id', userId) 
      // to the chain, making .eq() the final method.
      mockSupabase.eq.mockResolvedValueOnce({ 
        data: [{ id: 'att-2', user_id: 'specific-uuid-123' }] 
      });

      await getReport(req, res);
      const response = res._getJSONData();

      expect(res.statusCode).toBe(200);
      expect(response.records[0].user_id).toBe('specific-uuid-123');
    });
  });

  describe('overrideRecord (Admin)', () => {
    const { overrideRecord } = require('../controllers/attendanceController');

    it('should recalculate hours if admin provides both check-in and check-out times', async () => {
      req.params = { id: 'att-123' };
      req.body = { check_in_time: '09:00', check_out_time: '18:00' };

      // Mock fetching existing record
      mockSupabase.single.mockResolvedValueOnce({ data: { break_minutes: 60 } });
      
      hoursService.calculateHours.mockReturnValue({
        raw_hours: 9, normal_hours: 8, overtime_hours: 0, total_hours: 8
      });

      // Mock the update
      mockSupabase.single.mockResolvedValueOnce({ data: { id: 'att-123', total_hours: 8 } });

      await overrideRecord(req, res);
      
      expect(hoursService.calculateHours).toHaveBeenCalledWith('09:00', '18:00', 60);
      expect(res.statusCode).toBe(200);
    });
  });
});