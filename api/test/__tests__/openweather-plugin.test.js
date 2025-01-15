/**
 * @file __tests__/openweather-plugin.test.js
 * 
 * This test suite covers all tools from the OpenWeather plugin:
 * - openweather_help
 * - openweather_current_forecast
 * - openweather_timestamp
 * - openweather_daily_aggregation
 * - openweather_overview
 * 
 * It tests expected success scenarios and failing scenarios.
 */

const { createOpenWeatherHelpTool,
    createOpenWeatherCurrentForecastTool,
    createOpenWeatherTimestampTool,
    createOpenWeatherDailyAggregationTool,
    createOpenWeatherOverviewTool
} = require('../../app/clients/tools/openweather-plugin')

const fetch = require('node-fetch');
jest.mock('node-fetch', () => jest.fn());

describe('OpenWeather Plugin Tools', () => {
const MOCK_API_KEY = 'test-api-key';

// Mock successful fetch response
const mockSuccessResponse = (data) => {
fetch.mockResolvedValueOnce({
  ok: true,
  status: 200,
  json: async () => data
});
};

// Mock error fetch response
const mockErrorResponse = (status, message) => {
fetch.mockResolvedValueOnce({
  ok: false,
  status: status,
  json: async () => ({ cod: status, message })
});
};

beforeEach(() => {
jest.clearAllMocks();
process.env.OPENWEATHER_API_KEY = MOCK_API_KEY; 
});

describe('openweather_help tool', () => {
it('should return a help message with endpoints and usage', async () => {
  const helpTool = createOpenWeatherHelpTool();
  const result = await helpTool.call('');
  const parsed = JSON.parse(result);
  expect(parsed.title).toBe("OpenWeather One Call API 3.0 Help");
  expect(parsed.endpoints.current_and_forecast).toBeDefined();
});
});

describe('openweather_current_forecast tool', () => {
const tool = createOpenWeatherCurrentForecastTool();

it('should return current forecast data on success', async () => {
  mockSuccessResponse({
    lat: 33.44,
    lon: -94.04,
    current: { temp: 292.55 }
  });

  const result = await tool.call({
    lat: 33.44,
    lon: -94.04,
    exclude: 'hourly',
    units: 'metric',
    lang: 'en'
  });

  const parsed = JSON.parse(result);
  expect(parsed.lat).toBe(33.44);
  expect(parsed.current.temp).toBe(292.55);
});

it('should throw an error if API returns a failure status', async () => {
  mockErrorResponse(401, 'Unauthorized');
  await expect(tool.call({ lat: 33, lon: -94 }))
    .rejects.toThrow('Request failed with status 401');
});

it('should fail if required parameters are missing', async () => {
  // Missing lat/lon
  await expect(tool.call({ units: 'metric' }))
    .rejects.toThrow(); // Tool should complain about missing lat/lon
});
});

describe('openweather_timestamp tool', () => {
const tool = createOpenWeatherTimestampTool();

it('should return historical/future data on success', async () => {
  mockSuccessResponse({
    lat: 39.099724,
    lon: -94.578331,
    data: [{
      dt: 1643803200,
      temp: 279.13
    }]
  });

  const result = await tool.call({
    lat: 39.099724,
    lon: -94.578331,
    dt: 1643803200,
    units: 'imperial',
    lang: 'en'
  });

  const parsed = JSON.parse(result);
  expect(parsed.lat).toBe(39.099724);
  expect(parsed.data[0].dt).toBe(1643803200);
});

it('should handle not found errors gracefully', async () => {
  mockErrorResponse(404, 'Not found');
  await expect(tool.call({ lat: 0, lon: 0, dt: 1234567890 }))
    .rejects.toThrow('Request failed with status 404');
});
});

describe('openweather_daily_aggregation tool', () => {
const tool = createOpenWeatherDailyAggregationTool();

it('should return aggregated daily data', async () => {
  mockSuccessResponse({
    lat: 33,
    lon: 35,
    date: '2020-03-04',
    temperature: {
      min: 286.48,
      max: 299.24
    }
  });

  const result = await tool.call({
    lat: 33,
    lon: 35,
    date: '2020-03-04',
    units: 'metric',
    lang: 'en'
  });

  const parsed = JSON.parse(result);
  expect(parsed.date).toBe('2020-03-04');
  expect(parsed.temperature.min).toBe(286.48);
  expect(parsed.temperature.max).toBe(299.24);
});

it('should throw on invalid date format', async () => {
  mockErrorResponse(400, 'Invalid date format');
  await expect(tool.call({ lat: 33, lon: 35, date: 'invalid-date' }))
    .rejects.toThrow('Request failed with status 400');
});
});

describe('openweather_overview tool', () => {
const tool = createOpenWeatherOverviewTool();

it('should return a human-readable weather overview', async () => {
  mockSuccessResponse({
    lat: 51.509865,
    lon: -0.118092,
    date: "2024-05-13",
    weather_overview: "The current weather is overcast..."
  });

  const result = await tool.call({
    lat: 51.509865,
    lon: -0.118092,
    date: '2024-05-13',
    units: 'metric'
  });

  const parsed = JSON.parse(result);
  expect(parsed.lat).toBe(51.509865);
  expect(parsed.weather_overview).toContain("overcast");
});

it('should handle unauthorized errors', async () => {
  mockErrorResponse(401, 'Unauthorized');
  await expect(tool.call({ lat: 51.509865, lon: -0.118092 }))
    .rejects.toThrow('Request failed with status 401');
});
});
});
