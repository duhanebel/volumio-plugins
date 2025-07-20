'use strict';

const libQ = require('kew');
const axios = require('axios');
const DirectStreamingProxy = require('./DirectStreamingProxy');
const M3U8StreamingProxy = require('./M3U8StreamingProxy');

/**
 * Abstract base class for streaming proxies
 */
class StreamingProxy {
  constructor(logger, addAuthParamsCallback) {
    this.logger = logger;
    this.addAuthParamsCallback = addAuthParamsCallback;

    // Proxy server state
    this.proxyServer = null;
    this.proxyPort = null;

    // EventSource for metadata
    this.eventSource = null;
    this.aisSessionId = null;

    // Callback for metadata updates
    this.onMetadataUpdate = null;

    // Current stream info
    this.currentStreamUrl = null;
    this.currentStationCode = null;
  }

  /**
   * Static factory method to detect stream type and create appropriate proxy
   * @param {URL|string} streamUrl - The stream URL to analyze
   * @param {Object} logger - Logger instance
   * @param {Function} addAuthParamsCallback - Callback to add auth parameters
   * @returns {BaseStreamingProxy} - The appropriate streaming proxy instance
   */
  static createProxy(streamUrl, logger, addAuthParamsCallback) {
    // Detect stream type inline
    let streamType = 'direct_aac'; // Default to direct AAC stream
    if (streamUrl) {
      if (typeof streamUrl === 'string') {
        streamType = streamUrl.includes('.m3u8') ? 'hls_m3u8' : 'direct_aac';
      } else if (streamUrl.pathname) {
        streamType = streamUrl.pathname.includes('.m3u8') ? 'hls_m3u8' : 'direct_aac';
      }
    }

    logger.info(`Detected stream type: ${streamType} for URL: ${streamUrl}`);

    // Create appropriate proxy based on stream type
    if (streamType === 'hls_m3u8') {
      logger.info('Creating M3U8 streaming proxy for HLS stream');
      return new M3U8StreamingProxy(logger, addAuthParamsCallback);
    } else {
      logger.info('Creating direct streaming proxy for AAC stream');
      return new DirectStreamingProxy(logger, addAuthParamsCallback);
    }
  }

  /**
   * Set the metadata update callback
   * @param {Function} callback - Function to call when metadata changes
   */
  setMetadataCallback(callback) {
    this.onMetadataUpdate = callback;
  }

  /**
   * Start the proxy server for streaming
   * @param {URL} streamUrl - The stream URL object to proxy
   * @param {string} stationCode - The station code for metadata
   * @returns {Promise} - Promise that resolves when proxy is ready
   */
  startProxyServer(streamUrl, stationCode) {
    const self = this;
    const defer = libQ.defer();

    // Store current stream info
    self.currentStreamUrl = streamUrl;
    self.currentStationCode = stationCode;

    // Find an available port
    const server = require('net').createServer();
    server.listen(0, function () {
      self.proxyPort = server.address().port;
      server.close();

      // Create the proxy server
      self.proxyServer = require('http').createServer(function (req, res) {
        if (req.url === '/stream') {
          self.logger.info(`Proxying stream request to: ${streamUrl.toString()} `);
          self.handleStream(streamUrl, res);
        }
      });

      self.proxyServer.listen(self.proxyPort, function () {
        self.logger.info(`Proxy server listening on port ${self.proxyPort}`);
        defer.resolve();
      });
    });

    return defer.promise;
  }

  /**
   * Abstract method to handle the specific stream type
   * @param {URL} streamUrl - The stream URL object
   * @param {Object} res - HTTP response object
   */
  handleStream(_streamUrl, _res) {
    throw new Error('handleStream must be implemented by subclass');
  }

  /**
   * Get the proxy server port
   * @returns {number|null} - The proxy server port
   */
  getProxyPort() {
    return this.proxyPort;
  }

  /**
   * Get the local stream URL
   * @returns {string} - The local stream URL
   */
  getLocalStreamUrl() {
    return `http://localhost:${this.proxyPort}/stream`;
  }

  /**
   * Fetch and process metadata from URL
   * @param {string} metadataUrl - The metadata URL
   * @returns {Promise<Object|null>} - Promise resolving to metadata object or null
   */
  async fetchMetadataFromUrl(metadataUrl) {
    const self = this;

    // Skip the -1 event data URL (show information)
    if (metadataUrl && metadataUrl.endsWith('/eventdata/-1')) {
      self.logger.info('Skipping -1 event data URL, fetching show information');
      return await self.fetchShowData(self.currentStationCode);
    }

    if (!metadataUrl) {
      return null;
    }

    try {
      const response = await require('axios').get(metadataUrl);
      self.logger.info(`Fetched metadata from: ${metadataUrl}`);

      if (response.data) {
        const trackData = response.data;
        return self.createMetadataObject(trackData.eventSongTitle, trackData.eventSongArtist, '', trackData.eventImageUrl);
      }
      return null;
    } catch (error) {
      self.logger.error(`Failed to fetch metadata from URL: ${error.message}`);
      // Fallback to show data
      return await self.fetchShowData(self.currentStationCode);
    }
  }

  /**
   * Setup EventSource for metadata (to be implemented by subclasses that need it)
   */
  setupEventSource() {
    // Default implementation - subclasses can override if needed
    this.logger.info('EventSource setup not implemented for this proxy type');
  }

  /**
   * Parse metadata string
   * @param {string} metadata - The metadata string
   * @returns {Object} - Parsed metadata object
   */
  parseMetadataString(metadata) {
    const metadataObj = {};
    metadata.split(',').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key && value) {
        metadataObj[key] = value.replace(/^"|"$/g, '');
      }
    });
    return metadataObj;
  }

  /**
   * Create metadata object
   * @param {string} title - Track title
   * @param {string} artist - Track artist
   * @param {string} album - Track album
   * @param {string} albumart - Album art URL
   * @param {string} uri - Track URI
   * @returns {Object} - Metadata object
   */
  createMetadataObject(title, artist, album, albumart, uri) {
    return {
      title: title || 'Unknown Track',
      artist: artist || 'Planet Radio',
      album: album || '',
      albumart: albumart || '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp',
      uri: uri || this.getLocalStreamUrl(),
    };
  }

  /**
   * Update metadata immediately
   * @param {Object} metadata - The metadata to update
   */
  updateMetadata(metadata) {
    const self = this;

    if (!self.onMetadataUpdate) {
      return;
    }

    self.logger.info(`Updating metadata: ${JSON.stringify(metadata, null, 2)}`);
    self.onMetadataUpdate(metadata);
  }

  /**
   * Fetch show data for station
   * @param {string} stationCode - The station code
   * @returns {Promise<Object>} - Promise resolving to show metadata
   */
  async fetchShowData(stationCode) {
    const self = this;
    const url = `https://listenapi.planetradio.co.uk/api9.2/stations/GB?StationCode%5B%5D=${stationCode}&premium=1`;

    try {
      const response = await axios.get(url);
      self.logger.info('Show data response:', JSON.stringify(response.data, null, 2));

      if (response.data && response.data[0] && response.data[0].stationOnAir) {
        const showData = response.data[0].stationOnAir;
        return self.createMetadataObject(showData.episodeTitle, showData.stationName, showData.episodeDescription, showData.episodeImageUrl);
      }
      throw new Error('No show data available');
    } catch (error) {
      self.logger.error('Failed to fetch show data:', error.message);
      return self.createMetadataObject('Non stop music', 'Planet Rock', '', '');
    }
  }

  /**
   * Stop the proxy server and clean up resources
   */
  stop() {
    const self = this;
    self.logger.info('Stopping streaming proxy and cleaning up resources');

    // Stop the proxy server
    if (self.proxyServer) {
      self.proxyServer.close();
      self.proxyServer = null;
      self.proxyPort = null;
    }

    // Close EventSource connection
    if (self.eventSource) {
      self.eventSource.close();
      self.eventSource = null;
    }

    // Reset state
    self.currentStreamUrl = null;
    self.currentStationCode = null;

    self.logger.info('Streaming proxy cleanup completed');
  }
}

module.exports = StreamingProxy;
