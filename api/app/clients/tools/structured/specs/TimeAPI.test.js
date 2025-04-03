/**
 * File: TimeAPI.test.js
 */
const TimeAPI = require('../TimeAPI');
const fetch = require('node-fetch');

jest.setTimeout(15000); // in case requests take longer

describe('TimeAPI Tool', () => {
  describe('Unit Tests (Mocked)', () => {
    beforeAll(() => {
      // Mock the fetch function
      jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
        // Example: if the test requests /health/check, return a mock 200
        if (typeof url === 'string' && url.includes('/api/health/check')) {
          return {
            ok: true,
            status: 200,
            text: async () => 'OK',
          };
        }

        // Mock scenario: if you see a "zone?timeZone=Europe/Amsterdam", 
        // return a known JSON string
        if (url.includes('/api/time/current/zone')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ dateTime: '2025-01-30T10:00:00', timeZone: 'Europe/Amsterdam' }),
          };
        }

        // default fallback mock
        return {
          ok: false,
          status: 404,
          text: async () => 'Not Found (mock)',
        };
      });
    });

    afterAll(() => {
      jest.restoreAllMocks();
    });

    it('should return health_check success from mock', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({ action: 'health_check' });
      expect(result).toBe('Success: status 200');
    });

    it('should return current time (mocked) for Europe/Amsterdam', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({
        action: 'get_current_time_zone',
        timeZone: 'Europe/Amsterdam',
      });
      expect(result).toContain('Europe/Amsterdam');
    });

    it('should handle unknown route with 404 (mock)', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({
        action: 'get_current_time_zone',
        timeZone: 'Unknown/Zone',
      });
      expect(result).toContain('Error: status 404');
    });
  });

  describe('Integration Tests (Live)', () => {
    // We test the actual API. There's no key or cost, but note any rate limits on timeapi.io.
    it('health_check - should get 200 from live endpoint', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({ action: 'health_check' });
      // We expect "Success: status 200"
      expect(result).toContain('200');
    });

    it('list_timezones - should get 200 from live endpoint', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({ action: 'list_timezones' });
      // The result should be an array of strings, but we only assert status code presence
      expect(result).not.toContain('Error:');
    });

    it('get_current_time_zone - expect 200 for a valid zone', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({
        action: 'get_current_time_zone',
        timeZone: 'Europe/Amsterdam',
      });
      expect(result).not.toContain('Error:');
    });

    it('get_current_time_zone - expect 400 for missing param', async () => {
      const tool = new TimeAPI();
      const result = await tool.call({
        action: 'get_current_time_zone',
        // intentionally omit timeZone
      });
      expect(result).toContain('Error: Missing required "timeZone"');
    });
  });
});
