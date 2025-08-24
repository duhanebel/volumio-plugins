'use strict';

const DirectStreamPlayer = require('./DirectStreamPlayer');
const M3U8StreamingPlayer = require('./M3U8StreamingPlayer');

/**
 * Factory for creating stream players
 * Creates the appropriate player based on the stream URL type
 */
class StreamPlayerFactory {
  /**
   * Static factory method to detect stream type and create appropriate player
   * @param {URL} streamUrl - The stream URL to analyze
   * @param {Object} mpdPlugin - MPD plugin instance
   * @param {Object} logger - Logger instance
   * @param {Function} addAuthParamsCallback - Callback to add auth parameters
   * @param {Object} metadataFetcher - Metadata fetcher instance
   * @returns {DirectStreamPlayer|M3U8StreamingPlayer} - The appropriate player instance
   */
  static createPlayer(streamUrl, mpdPlugin, logger, addAuthParamsCallback, metadataFetcher) {
    // Create appropriate player based on stream type
    if (streamUrl.pathname.includes('.m3u8')) {
      logger.info('Creating M3U8 streaming player for HLS stream');
      return new M3U8StreamingPlayer(streamUrl, mpdPlugin, logger, addAuthParamsCallback, metadataFetcher);
    } else {
      logger.info('Creating direct stream player for AAC stream');
      return new DirectStreamPlayer(streamUrl, mpdPlugin, logger, addAuthParamsCallback, metadataFetcher);
    }
  }
}

module.exports = StreamPlayerFactory;
