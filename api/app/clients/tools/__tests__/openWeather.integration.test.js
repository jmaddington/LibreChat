// __tests__/openWeather.integration.test.js
const OpenWeather = require('../structured/OpenWeather');
const fetch = require('node-fetch');

// If you haven’t mocked fetch globally for other tests, you may remove the mocking.
// If fetch is mocked globally, you will need to unmock it here.
// For example:
// jest.unmock('node-fetch');

describe('OpenWeather Tool (Integration Test)', () => {
  let tool;

  beforeAll(() => {
    tool = new OpenWeather();
  });

  test('current_forecast with a real API key, if available', async () => {
    // Check if API key is available
    if (!process.env.OPENWEATHER_API_KEY) {
      console.warn("Skipping real API test, no OPENWEATHER_API_KEY found.");
      return; // Test passes but does nothing
    }

    // Provide a real city and action
    const result = await tool.call({
      action: 'current_forecast',
      city: 'London',
      units: 'Celsius'
    });

    // Try to parse the JSON result
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch (e) {
      throw new Error(`Could not parse JSON from response: ${result}`);
    }

    // Check that the response contains expected fields
    expect(parsed).toHaveProperty('current');
    expect(typeof parsed.current.temp).toBe('number');
  });
});
