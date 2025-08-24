'use strict';

const DirectStreamingProxy = require('./DirectStreamingProxy');
const SimplifiedM3U8Manager = require('./SimplifiedM3U8Manager');

/**
 * Factory for creating streaming proxies
 */
class StreamingProxyFactory {
  /**
   * Static factory method to detect stream type and create appropriate proxy
   * @param {URL} streamUrl - The stream URL to analyze
   * @param {Object} logger - Logger instance
   * @param {Function} addAuthParamsCallback - Callback to add auth parameters
   * @param {Object} mpdPlugin - MPD plugin instance (required for M3U8)
   * @param {Object} metadataFetcher - Metadata fetcher instance (required for M3U8)
   * @returns {BaseStreamingProxy|SimplifiedM3U8Manager} - The appropriate streaming proxy instance
   */
  static createProxy(streamUrl, logger, addAuthParamsCallback, mpdPlugin, metadataFetcher) {
    // Create appropriate proxy based on stream type
    if (streamUrl.pathname.includes('.m3u8')) {
      logger.info('Creating simplified M3U8 manager for HLS stream (using MPD queue)');
      return new SimplifiedM3U8Manager(logger, mpdPlugin, metadataFetcher, addAuthParamsCallback);
    } else {
      logger.info('Creating direct streaming proxy for AAC stream');
      return new DirectStreamingProxy(logger, addAuthParamsCallback, metadataFetcher);
    }
  }
}

module.exports = StreamingProxyFactory;
