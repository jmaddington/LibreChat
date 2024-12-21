// __tests__/openWeather.test.js
const OpenWeather = require('../structured/OpenWeather');
const fetch = require('node-fetch');

// Mock environment variable
process.env.OPENWEATHER_API_KEY = 'test-api-key';

// Mock the fetch function globally
jest.mock('node-fetch', () => jest.fn());

describe('OpenWeather Tool', () => {
  let tool;

  beforeAll(() => {
    tool = new OpenWeather();
  });

  beforeEach(() => {
    fetch.mockReset();
  });

  test('action=help returns help instructions', async () => {
    const result = await tool.call({
      action: 'help'
    });

    expect(typeof result).toBe('string');
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe('OpenWeather One Call API 3.0 Help');
  });

  test('current_forecast with a city and successful geocoding + forecast', async () => {
    // Mock geocoding response
    fetch.mockImplementationOnce((url) => {
      if (url.includes('geo/1.0/direct')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ lat: 35.9606, lon: -83.9207 }]
        });
      }
      return Promise.reject('Unexpected fetch call for geocoding');
    });

    // Mock forecast response
    fetch.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: async () => ({
        current: { temp: 293.15, feels_like: 295.15 },
        daily: [{ temp: { day: 293.15, night: 283.15 } }]
      })
    }));

    const result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee',
      units: 'Kelvin'
    });

    const parsed = JSON.parse(result);
    expect(parsed.current.temp).toBe(293);
    expect(parsed.current.feels_like).toBe(295);
    expect(parsed.daily[0].temp.day).toBe(293);
    expect(parsed.daily[0].temp.night).toBe(283);
  });

  test('timestamp action without a date returns an error message', async () => {
    const result = await tool.call({
      action: 'timestamp',
      lat: 35.9606,
      lon: -83.9207
    });
    expect(result).toMatch(/Error: For timestamp action, a 'date' in YYYY-MM-DD format is required./);
  });

  test('unknown action returns an error due to schema validation', async () => {
    await expect(tool.call({
      action: 'unknown_action'
    })).rejects.toThrow(/Received tool input did not match expected schema/);
  });
  

  test('geocoding failure returns a descriptive error', async () => {
    fetch.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: async () => []
    }));

    const result = await tool.call({
      action: 'current_forecast',
      city: 'NowhereCity'
    });
    expect(result).toMatch(/Error: Could not find coordinates for city: NowhereCity/);
  });

  test('API request failure returns an error', async () => {
    // Mock geocoding success
    fetch.mockImplementationOnce(() => Promise.resolve({
      ok: true,
      json: async () => [{ lat: 35.9606, lon: -83.9207 }]
    }));

    // Mock weather request failure (e.g., 404)
    fetch.mockImplementationOnce(() => Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not found' })
    }));

    const result = await tool.call({
      action: 'current_forecast',
      city: 'Knoxville, Tennessee'
    });
    // Adjusted regex to match without quotes
    expect(result).toMatch(/Error: OpenWeather API request failed with status 404: Not found/);
  });
});
