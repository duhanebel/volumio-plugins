'use strict';

const libQ = require('kew');
const axios = require('axios');

// Constants
const HTTP_NOT_FOUND = 404;

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

    try {
      // Create the proxy server and find an available port
      self.proxyServer = require('http').createServer(function (req, res) {
        if (req.url === '/stream') {
          self.logger.info(`Proxying stream request to: ${streamUrl.toString()} `);
          self.handleStream(streamUrl, res);
        } else {
          // Handle unknown routes
          self.logger.warn(`Unknown route requested: ${req.url}`);
          res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      // Add error handling for the server
      self.proxyServer.on('error', function (error) {
        self.logger.error(`Proxy server error: ${error.message}`);
        defer.reject(error);
      });

      self.proxyServer.listen(0, function () {
        try {
          self.proxyPort = self.proxyServer.address().port;
          self.logger.info(`Proxy server listening on port ${self.proxyPort}`);
          defer.resolve();
        } catch (error) {
          self.logger.error(`Failed to get proxy server port: ${error.message}`);
          defer.reject(error);
        }
      });
    } catch (error) {
      self.logger.error(`Failed to create proxy server: ${error.message}`);
      defer.reject(error);
    }

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
        return self.createMetadataObject(trackData.eventSongTitle, trackData.eventSongArtist, null, trackData.eventImageUrl);
      }
      return null;
    } catch (error) {
      self.logger.error(`Failed to fetch metadata from URL: ${error.message}`);
      // Fallback to show data
      return await self.fetchShowData(self.currentStationCode);
    }
  }

  /**
   * Common method to fetch and update metadata
   * @param {string} metadataUrl - The metadata URL
   * @param {string} context - Context for logging (e.g., 'segment', 'EventSource')
   * @returns {Promise<void>}
   */
  async fetchAndUpdateMetadata(metadataUrl, context = 'unknown') {
    const self = this;

    if (!metadataUrl) {
      return;
    }

    try {
      const metadata = await self.fetchMetadataFromUrl(metadataUrl);
      if (metadata && self.onMetadataUpdate) {
        self.logger.info(`Updated metadata from ${context}: ${JSON.stringify(metadata, null, 2)}`);
        self.onMetadataUpdate(metadata);
      }
    } catch (error) {
      self.logger.error(`Failed to fetch metadata from ${context}: ${error.message}`);
    }
  }

  /**
   * Create metadata object
   * @param {string} title - Track title
   * @param {string} artist - Track artist
   * @param {string} album - Track album
   * @param {string} albumart - Album art URL
   * @returns {Object} - Metadata object
   */
  createMetadataObject(title, artist, album, albumart) {
    return {
      title: title == '' ? null : title,
      artist: artist == '' ? null : artist,
      album: album == '' ? null : album,
      albumart: albumart == '' ? null : albumart,
    };
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
        return self.createMetadataObject(showData.episodeTitle, showData.stationName, null, showData.episodeImageUrl);
      }
      throw new Error('No show data available');
    } catch (error) {
      self.logger.error('Failed to fetch show data:', error.message);
      return self.createMetadataObject('Non stop music', 'Planet Rock', null, null);
    }
  }

  /**
   * Common method to create HTTP request options with standard headers
   * @returns {Object} - HTTP request options
   */
  getCommonRequestOptions() {
    return {
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
      },
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    };
  }

  /**
   * Common method to handle stream errors
   * @param {Error} error - The error object
   * @param {string} context - Context for logging (e.g., 'segment', 'direct stream')
   * @param {Object} res - HTTP response object (optional)
   */
  handleStreamError(error, context = 'unknown', res = null) {
    const self = this;
    self.logger.error(`${context} error: ${error.message}`);

    if (res && !res.headersSent) {
      const HTTP_INTERNAL_SERVER_ERROR = 500;
      res.writeHead(HTTP_INTERNAL_SERVER_ERROR);
      res.end();
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
