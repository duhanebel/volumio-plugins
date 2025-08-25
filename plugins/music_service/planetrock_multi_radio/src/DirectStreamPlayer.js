'use strict';

const libQ = require('kew');
const axios = require('axios');

// Constants
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const RETRY_DELAY = 1000;

/**
 * Direct Stream Player for AAC streams
 * Manages direct streaming through a proxy server
 */
class DirectStreamPlayer {
  constructor(url, mpdPlugin, logger, addAuthParamsCallback, metadataFetcher) {
    this.url = url;
    this.mpdPlugin = mpdPlugin;
    this.logger = logger;
    this.addAuthParamsCallback = addAuthParamsCallback;
    
    // Use passed metadata fetcher
    this.metadataFetcher = metadataFetcher;
    
    // Proxy server state
    this.proxyServer = null;
    this.proxyPort = null;
    
    // Current stream info
    this.streamURL = null;
    this.stationCode = null;
    
    // EventSource for live metadata
    this.eventSource = null;
    this.aisSessionId = null;
    
    // State
    this.isPlaying = false;
  }

  /**
   * Setup EventSource for live metadata
   */
  setupEventSource() {
    const self = this;

    if (!self.aisSessionId) {
      self.logger.error('No AISSessionId available for EventSource connection');
      return;
    }

    const url = 'https://stream-mz.hellorayo.co.uk/metadata?type=json';
    self.logger.info(`Connecting to EventSource URL: ${url}`);

    const options = {
      headers: {
        Cookie: self.aisSessionId,
        Accept: 'text/event-stream',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
      },
      rejectUnauthorized: false,
    };

    // Close existing EventSource if any
    if (self.eventSource) {
      self.logger.info('Closing existing EventSource connection');
      self.eventSource.close();
    }

    // Create new EventSource connection
    self.eventSource = new (require('eventsource'))(url, options);

    self.eventSource.onopen = function () {
      self.logger.info('EventSource connection established');
    };

    self.eventSource.onerror = function (error) {
      const timestamp = new Date().toISOString();
      self.logger.error(`[${timestamp}] EventSource error:`, JSON.stringify(error, null, 2));

      if (self.eventSource.readyState === require('eventsource').CLOSED) {
        self.logger.info(`[${timestamp}] Connection closed, attempting to reconnect in 1 second...`);
        setTimeout(() => self.setupEventSource(), RETRY_DELAY);
      }
    };

    self.eventSource.onmessage = function (event) {
      try {
        self.logger.info(`Received raw EventSource message: ${event.data}`);

        const messageData = JSON.parse(event.data);

        if (messageData['metadata-list'] && messageData['metadata-list'].length > 0) {
          const [{ metadata }] = messageData['metadata-list'];
          self.logger.info(`Extracted metadata string: ${metadata}`);

          const metadataObj = self.parseMetadataString(metadata);
          self.logger.info(`Parsed metadata object: ${JSON.stringify(metadataObj, null, 2)}`);

          if (metadataObj.url) {
            self.metadataFetcher.fetchAndUpdateMetadata(metadataObj.url, 'EventSource');
          }
        }
      } catch (error) {
        self.logger.error(`Failed to parse EventSource message: ${error.message}`);
      }
    };
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
   * Start the direct stream
   * @returns {Promise} - Promise that resolves when stream is ready
   */
  async start() {
    this.logger.info(`Starting direct stream player for: ${this.url.toString()}`);
    
    try {
      // Start the proxy server
      await this.startProxyServer(this.url, 'direct');
      
      // Get the local proxy URL for MPD
      this.localStreamUrl = this.getLocalStreamUrl();
      
      this.logger.info('Sending MPD stop command...');
      await this.mpdPlugin.sendMpdCommand('stop', []);
      
      this.logger.info('Sending MPD clear command...');
      await this.mpdPlugin.sendMpdCommand('clear', []);
      
      this.logger.info('Sending MPD add command...');
      await this.mpdPlugin.sendMpdCommand(`add "${this.localStreamUrl}"`, []);
      
      this.logger.info('Sending MPD consume command...');
      await this.mpdPlugin.sendMpdCommand('consume 1', []);
      
      this.logger.info('Sending MPD play command...');
      await this.mpdPlugin.sendMpdCommand('play', []);
      
      this.logger.info('All MPD commands completed successfully');
      
      this.isPlaying = true;
      this.logger.info('Direct stream player started successfully');
      
      return this.localStreamUrl;
    } catch (error) {
      this.logger.error(`Failed to start direct stream player: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop the direct stream
   */
  stop() {
    this.logger.info('Stopping direct stream player');
    
    try {
      // Stop the proxy server
      if (this.proxyServer) {
        this.proxyServer.close();
        this.proxyServer = null;
        this.proxyPort = null;
      }
      
      // Close EventSource connection
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      
      // Reset state
      this.streamURL = null;
      this.stationCode = null;
      this.aisSessionId = null;
      this.isPlaying = false;
      this.localStreamUrl = null;
      
      this.logger.info('Direct stream player stopped');
    } catch (error) {
      this.logger.error(`Error during direct stream player cleanup: ${error.message}`);
    }
  }

  /**
   * Get the local stream URL for MPD
   * @returns {string} - The local stream URL
   */
  getLocalStreamUrl() {
    return `http://localhost:${this.proxyPort}/stream`;
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
          self.logger.info(`Proxying stream request to: ${streamUrl.toString()}`);
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
   * Handle direct streaming by proxying the stream data
   * @param {URL} streamUrl - The stream URL object
   * @param {Object} res - HTTP response object
   */
  async handleStream(streamUrl, res) {
    const self = this;
    
    try {
      const authenticatedStreamUrl = self.addAuthParamsCallback(streamUrl);
      self.logger.info(`Starting direct stream handling for URL: ${authenticatedStreamUrl.toString()}`);

      const response = await axios({
        method: 'get',
        url: authenticatedStreamUrl.toString(),
        responseType: 'stream',
        ...self.getCommonRequestOptions(),
      });

      self.logger.info(`Stream response received, status: ${response.status}`);

      // Get cookies from response
      const cookies = response.headers['set-cookie'];
      if (cookies) {
        for (const cookie of cookies) {
          if (cookie.startsWith('AISSessionId=')) {
            self.aisSessionId = cookie.split(';')[0];
            self.logger.info(`Captured AISSessionId: ${self.aisSessionId}`);
            // Start metadata connection
            self.setupEventSource();
            break;
          }
        }
      }

      // Set appropriate headers for streaming
      res.writeHead(HTTP_OK, {
        'Content-Type': 'audio/aac',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      self.logger.info('Stream headers set, starting to pipe data...');

      // Pipe the stream data to the response
      response.data.pipe(res);

      // Handle stream end
      response.data.on('end', () => {
        self.logger.info('Direct stream ended');
        res.end();
      });

      // Handle stream error
      response.data.on('error', (error) => {
        self.logger.error(`Direct stream error: ${error.message}`);
        self.handleStreamError(error, 'direct stream', res);
      });

    } catch (error) {
      self.logger.error(`Failed to handle direct stream: ${error.message}`);
      self.handleStreamError(error, 'direct stream', res);
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
      res.writeHead(HTTP_INTERNAL_SERVER_ERROR);
      res.end();
    }
  }
}

module.exports = DirectStreamPlayer;
