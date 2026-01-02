'use strict';

const axios = require('axios');

/**
 * M3U8 Streaming Player for HLS streams
 * Manages playlist refresh and enqueues segments to MPD for playback
 */
class M3U8StreamingPlayer {
  constructor(url, mpdPlugin, logger, addAuthParamsCallback, metadataFetcher) {
    this.url = url;
    this.mpdPlugin = mpdPlugin;
    this.logger = logger;
    this.addAuthParamsCallback = addAuthParamsCallback;

    // Use passed metadata fetcher
    this.metadataFetcher = metadataFetcher;

    // State management
    this.isPlaying = false;
    this.lastMetadataUrl = null;
    this.lastAddedProgressiveCounter = 0;
    this.monitoringInterval = null;
    this.currentMediaPlaylistUrl = null;
  }

  /**
   * Start the M3U8 stream
   * @returns {Promise} - Promise that resolves when stream is ready
   */
  async start() {
    this.logger.info(`Starting M3U8 streaming player for: ${this.url.toString()}`);

    try {
      this.logger.info('Sending MPD stop command...');
      await this.mpdPlugin.sendMpdCommand('stop', []);

      this.logger.info('Sending MPD clear command...');
      await this.mpdPlugin.sendMpdCommand('clear', []);

      // Initial setup - fetch and enqueue all segments
      await this.refreshAndEnqueueSegments();

      this.logger.info('Sending MPD consume command...');
      await this.mpdPlugin.sendMpdCommand('consume 1', []);

      this.logger.info('Sending MPD play command...');
      await this.mpdPlugin.sendMpdCommand('play', []);

      this.logger.info('All MPD commands completed successfully');

      // Start monitoring for updates every 10 seconds
      this.startMonitoring();

      this.isPlaying = true;
      this.logger.info('M3U8 streaming player started successfully');

      return 'mpd://'; // Return MPD protocol since segments are in queue
    } catch (error) {
      this.logger.error(`Failed to start M3U8 streaming player: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop the M3U8 stream
   */
  async stop() {
    this.logger.info('Stopping M3U8 streaming player');

    this.isPlaying = false;
    await this.mpdPlugin.stop();
    await this.mpdPlugin.sendMpdCommand('clear', []);

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Reset state
    this.lastMetadataUrl = null;
    this.lastAddedProgressiveCounter = 0;
    this.currentMediaPlaylistUrl = null;

    this.logger.info('M3U8 streaming player stopped');
  }

  /**
   * Refresh playlist and add new segments to MPD queue
   */
  async refreshAndEnqueueSegments() {
    try {
      // First, try to resolve master playlist to get the media playlist URL
      let mediaPlaylistUrl = this.currentMediaPlaylistUrl;

      if (!mediaPlaylistUrl) {
        // First time - resolve the master playlist
        mediaPlaylistUrl = await this.resolveMasterPlaylist(this.url);

        // If no media playlist URL found, assume this.url is already a media playlist
        if (!mediaPlaylistUrl) {
          mediaPlaylistUrl = this.url;
          this.logger.info('Using provided URL as media playlist (not a master playlist)');
        }

        // Store the resolved media playlist URL for future use
        this.currentMediaPlaylistUrl = mediaPlaylistUrl;
      }

      // Fetch and parse the media playlist
      const segments = await this.fetchM3u8Playlist(mediaPlaylistUrl);

      if (segments.length === 0) {
        this.logger.warn('No segments found in refreshed playlist');
        return;
      }

      // Check if first segment has new metadata
      if (segments.length > 0 && segments[0].metadataUrl && segments[0].metadataUrl !== this.lastMetadataUrl) {
        this.logger.info(`New metadata URL detected: ${segments[0].metadataUrl}`);
        // For M3U8 streaming, update metadata immediately without delay
        await this.metadataFetcher.fetchAndUpdateMetadata(segments[0].metadataUrl, 'segment');
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
          // Add authentication to the segment URL before adding to MPD
          const authenticatedSegmentUrl = this.addAuthParamsCallback(new URL(segment.segmentUrl));
          await this.mpdPlugin.sendMpdCommand(`add "${authenticatedSegmentUrl.toString()}"`, []);
          this.logger.debug(`Added authenticated segment to MPD: ${authenticatedSegmentUrl.toString()}`);
        }

        // Update the last counter we added
        const lastNewSegment = newSegments[newSegments.length - 1];
        this.lastAddedProgressiveCounter = this.extractProgressiveCounter(lastNewSegment.segmentUrl);

        this.logger.debug(`Added ${newSegments.length} new segments to MPD queue. Last counter: ${this.lastAddedProgressiveCounter}`);
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

    const MONITORING_INTERVAL_MS = 10000; // 10 seconds
    this.monitoringInterval = setInterval(async () => {
      if (this.isPlaying) {
        await this.refreshAndEnqueueSegments();
      }
    }, MONITORING_INTERVAL_MS);
  }

  /**
   * Resolve master playlist to get the media playlist URL
   * @param {URL} playlistUrl - The master playlist URL
   * @returns {Promise<URL|null>} - The media playlist URL or null if not a master playlist
   */
  async resolveMasterPlaylist(playlistUrl) {
    try {
      // Add authentication to the master playlist URL before fetching
      const authenticatedPlaylistUrl = this.addAuthParamsCallback(playlistUrl);

      const response = await axios.get(authenticatedPlaylistUrl.toString(), {
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        },
      });

      // Check if this is a master playlist (contains stream variants)
      if (response.data.includes('#EXT-X-STREAM-INF:')) {
        const mediaPlaylistUrl = this.parseMasterPlaylist(response.data);

        if (mediaPlaylistUrl) {
          this.logger.debug(`Found media playlist URL: ${mediaPlaylistUrl.toString()}`);
          return mediaPlaylistUrl;
        }
      }

      // Not a master playlist, return null
      return null;
    } catch (error) {
      this.logger.error(`Failed to resolve master playlist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse master playlist to extract the media playlist URL
   * @param {string} playlistContent - The playlist content
   * @returns {URL|null} - The media playlist URL object or null if not found
   */
  parseMasterPlaylist(playlistContent) {
    const lines = playlistContent.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comment lines
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // Return the first URL that contains 'playlist.m3u8' in the path
      if (trimmedLine.includes('playlist.m3u8')) {
        return new URL(trimmedLine);
      }
    }

    return null;
  }

  /**
   * Fetch and parse M3U8 media playlist
   * @param {URL} playlistUrl - The media playlist URL object
   * @returns {Promise<Array>} - Promise resolving to array of segments
   */
  async fetchM3u8Playlist(playlistUrl) {
    try {
      // Add authentication to the playlist URL before fetching
      const authenticatedPlaylistUrl = this.addAuthParamsCallback(playlistUrl);

      const response = await axios.get(authenticatedPlaylistUrl.toString(), {
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
}

module.exports = M3U8StreamingPlayer;
