'use strict';

const libQ = require('kew');
const MetadataFetcher = require('./MetadataFetcher');

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

    // Metadata fetcher
    this.metadataFetcher = new MetadataFetcher(logger);

    // Current stream info
    this.streamURL = null;
    this.stationCode = null;
  }

  /**
   * Set the metadata update callback
   * @param {Function} callback - Function to call when metadata changes
   */
  setMetadataCallback(callback) {
    this.metadataFetcher.setMetadataCallback(callback);
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
    self.streamURL = streamUrl;
    self.stationCode = stationCode;

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

    try {
      // Stop the proxy server
      if (self.proxyServer) {
        self.proxyServer.close();
        self.proxyServer = null;
        self.proxyPort = null;
      }

      // Reset state
      self.streamURL = null;
      self.stationCode = null;

      self.logger.info('Streaming proxy cleanup completed');
    } catch (error) {
      self.logger.error(`Error during streaming proxy cleanup: ${error.message}`);
    }
  }
}

module.exports = StreamingProxy;
