const manifest = require('./manifest');

// Structured Tools
const DALLE3 = require('./structured/DALLE3');
const FluxAPI = require('./structured/FluxAPI');
const OpenWeather = require('./structured/OpenWeather');
const StructuredWolfram = require('./structured/Wolfram');
const createYouTubeTools = require('./structured/YouTube');
const StructuredACS = require('./structured/AzureAISearch');
const StructuredSD = require('./structured/StableDiffusion');
const GoogleSearchAPI = require('./structured/GoogleSearch');
const TraversaalSearch = require('./structured/TraversaalSearch');
const createOpenAIImageTools = require('./structured/OpenAIImageTools');
const TavilySearchResults = require('./structured/TavilySearchResults');
const WebNavigator = require('./structured/WebNavigator');
const E2BCode = require('./structured/E2BCode');
const TimeAPI = require('./structured/TimeAPI');
const Quickchart = require('./structured/Quickchart');
const WordPress = require('./structured/WordPress');
const Collections = require('./structured/Collections');
const CollectionExport = require('./structured/CollectionExport');
const QuickLCMemory = require('./structured/QuickLCMemory');

module.exports = {
  ...manifest,
  // Structured Tools
  DALLE3,
  FluxAPI,
  OpenWeather,
  StructuredSD,
  StructuredACS,
  GoogleSearchAPI,
  TraversaalSearch,
  StructuredWolfram,
  createYouTubeTools,
  TavilySearchResults,
  createOpenAIImageTools,
  WebNavigator,
  E2BCode,
  TimeAPI,
  Quickchart,
  WordPress,
  Collections,
  CollectionExport,
  QuickLCMemory,
};
