'use strict';

const axios = require('axios');

/**
 * Simplified M3U8 Manager that uses MPD queue instead of manual streaming
 * Manages playlist refresh and enqueues segments to MPD for playback
 */
class SimplifiedM3U8Manager {
  constructor(logger, mpdPlugin, metadataFetcher, addAuthParamsCallback) {
    this.logger = logger;
    this.mpdPlugin = mpdPlugin;
    this.metadataFetcher = metadataFetcher;
    this.addAuthParamsCallback = addAuthParamsCallback;
    
    // State management
    this.currentPlaylistUrl = null;
    this.lastMetadataUrl = null;
    this.lastAddedProgressiveCounter = 0;
    this.monitoringInterval = null;
    this.isMonitoring = false;
  }

  /**
   * Set the metadata update callback (required for compatibility with existing code)
   * @param {Function} callback - Function to call when metadata changes
   */
  setMetadataCallback(callback) {
    this.metadataCallback = callback;
    this.logger.info('Metadata callback set for simplified M3U8 manager');
  }

  /**
   * Start managing M3U8 stream by enqueueing segments to MPD
   * @param {URL} playlistUrl - The M3U8 playlist URL
   * @param {string} stationCode - The station code for metadata
   */
  async startStream(playlistUrl, stationCode) {
    this.logger.info(`Starting simplified M3U8 stream management for: ${playlistUrl.toString()}`);
    
    this.currentPlaylistUrl = playlistUrl;
    this.stationCode = stationCode;
    
    try {
      // Initial setup - fetch and enqueue all segments
      await this.refreshAndEnqueueSegments();
      
      // Start monitoring for updates every 10 seconds
      this.startMonitoring();
      
      this.logger.info('Simplified M3U8 stream management started successfully');
    } catch (error) {
      this.logger.error(`Failed to start M3U8 stream management: ${error.message}`);
      throw error;
    }
  }

  /**
   * Refresh playlist and add new segments to MPD queue
   */
  async refreshAndEnqueueSegments() {
    if (!this.currentPlaylistUrl) {
      this.logger.warn('No playlist URL set, cannot refresh');
      return;
    }

    try {
      // Fetch and parse the playlist
      const segments = await this.fetchM3u8Playlist(this.currentPlaylistUrl);
      
      if (segments.length === 0) {
        this.logger.warn('No segments found in refreshed playlist');
        return;
      }

      // Check if first segment has new metadata
      if (segments.length > 0 && segments[0].metadataUrl && segments[0].metadataUrl !== this.lastMetadataUrl) {
        this.logger.info(`New metadata URL detected: ${segments[0].metadataUrl}`);
        await this.updateMetadata(segments[0].metadataUrl);
        this.lastMetadataUrl = segments[0].metadataUrl;
      }

      // Filter segments to only add NEW ones (progressiveCounter > lastAddedCounter)
      const newSegments = segments.filter(segment => {
        const progressiveCounter = this.extractProgressiveCounter(segment.segmentUrl);
        return progressiveCounter > this.lastAddedProgressiveCounter;
      });

      if (newSegments.length > 0) {
        this.logger.info(`Found ${newSegments.length} new segments to add to MPD queue`);
        
        // Add new segments to MPD queue
        for (const segment of newSegments) {
          await this.mpdPlugin.sendMpdCommand(`add "${segment.segmentUrl}"`, []);
          this.logger.debug(`Added segment to MPD: ${segment.segmentUrl}`);
        }

        // Update the last counter we added
        const lastNewSegment = newSegments[newSegments.length - 1];
        this.lastAddedProgressiveCounter = this.extractProgressiveCounter(lastNewSegment.segmentUrl);
        
        this.logger.info(`Added ${newSegments.length} new segments to MPD queue. Last counter: ${this.lastAddedProgressiveCounter}`);
      } else {
        this.logger.debug('No new segments to add to MPD queue');
      }
    } catch (error) {
      this.logger.error(`Failed to refresh and enqueue segments: ${error.message}`);
    }
  }

  /**
   * Start monitoring playlist for updates every 10 seconds
   */
  startMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    this.isMonitoring = true;
    const MONITORING_INTERVAL_MS = 10000; // 10 seconds
    this.monitoringInterval = setInterval(async () => {
      if (this.isMonitoring) {
        await this.refreshAndEnqueueSegments();
      }
    }, MONITORING_INTERVAL_MS);

    this.logger.info('Started playlist monitoring (10 second intervals)');
  }

  /**
   * Stop monitoring and clean up resources
   */
  stop() {
    this.logger.info('Stopping simplified M3U8 stream management');
    
    this.isMonitoring = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Reset state
    this.currentPlaylistUrl = null;
    this.lastMetadataUrl = null;
    this.lastAddedProgressiveCounter = 0;
    
    this.logger.info('Simplified M3U8 stream management stopped');
  }

  /**
   * Fetch and parse M3U8 media playlist
   * @param {URL} playlistUrl - The media playlist URL object
   * @returns {Promise<Array>} - Promise resolving to array of segments
   */
  async fetchM3u8Playlist(playlistUrl) {
    try {
      const response = await axios.get(playlistUrl.toString(), {
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        },
      });

      const segments = this.parseM3u8Playlist(response.data);
      return segments;
    } catch (error) {
      this.logger.error(`Failed to fetch M3U8 playlist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse M3U8 media playlist to extract segments and metadata URLs
   * @param {string} playlistContent - The playlist content
   * @returns {Array<Object>} - Array of segment objects
   */
  parseM3u8Playlist(playlistContent) {
    const segments = [];
    const lines = playlistContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Parse segment information with metadata URLs
      if (line.startsWith('#EXTINF:')) {
        // Next line should be the segment URL
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          const duration = parseFloat(line.split(':')[1].split(',')[0]);
          const segmentUrl = lines[i + 1].trim();

          // Extract metadata URL from the title property
          const metadataUrl = this.extractMetadataUrlFromExtinf(line);

          segments.push({
            duration,
            segmentUrl,
            metadataUrl,
          });
        }
      }
    }

    return segments;
  }

  /**
   * Extract metadata URL from #EXTINF line
   * @param {string} extinfLine - The #EXTINF line
   * @returns {string|null} - Metadata URL or null if not found
   */
  extractMetadataUrlFromExtinf(extinfLine) {
    // Parse the url property which contains the metadata URL
    const urlMatch = extinfLine.match(/url="([^"]+)"/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    // Fallback to title property if title is not found
    const titleMatch = extinfLine.match(/title="([^"]+)"/);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1];
    }

    return null;
  }

  /**
   * Extract progressive counter from segment URL
   * @param {string} segmentUrl - The segment URL
   * @returns {number} - The progressive counter value, or 0 if not found
   */
  extractProgressiveCounter(segmentUrl) {
    // Extract progressive counter from URL format:
    // https://chunks-aphls.hellorayo.co.uk/pr_webcast1_master.aac/[random id]-[progressive counter]-[other id].aac
    const match = segmentUrl.match(/\/([^-]+)-(\d+)-([^-]+)\.aac$/);
    if (match) {
      const counter = parseInt(match[2], 10);
      return isNaN(counter) ? 0 : counter;
    }
    return 0;
  }

  /**
   * Update metadata using the metadata fetcher
   * @param {string} metadataUrl - The metadata URL
   */
  async updateMetadata(metadataUrl) {
    if (this.metadataFetcher && this.stationCode) {
      try {
        const metadata = await this.metadataFetcher.fetchAndUpdateMetadata(metadataUrl, this.stationCode, 'segment');
        this.logger.info(`Metadata updated from: ${metadataUrl}`);
        
        // Call the metadata callback if it's set
        if (this.metadataCallback && metadata) {
          this.metadataCallback(metadata);
        }
      } catch (error) {
        this.logger.error(`Failed to update metadata: ${error.message}`);
      }
    } else {
      this.logger.warn('Metadata fetcher or station code not available');
    }
  }
}

module.exports = SimplifiedM3U8Manager;
