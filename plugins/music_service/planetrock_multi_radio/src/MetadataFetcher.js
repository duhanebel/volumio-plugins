'use strict';

const axios = require('axios');

/**
 * Handles metadata fetching and processing for streaming services
 */
class MetadataFetcher {
  constructor(logger) {
    this.logger = logger;
    this.onMetadataUpdate = null;
  }

  /**
   * Set the metadata update callback
   * @param {Function} callback - Function to call when metadata changes
   */
  setMetadataCallback(callback) {
    this.onMetadataUpdate = callback;
  }

  /**
   * Fetch and process metadata from URL
   * @param {string} metadataUrl - The metadata URL
   * @param {string} stationCode - The station code for fallback data
   * @returns {Promise<Object|null>} - Promise resolving to metadata object or null
   */
  async fetchMetadataFromUrl(metadataUrl, stationCode) {
    if (!metadataUrl) {
      return null;
    }

    // Skip the -1 event data URL (show information)
    if (metadataUrl.endsWith('/eventdata/-1')) {
      this.logger.info('Skipping -1 event data URL, fetching show information');
      return await this.fetchShowData(stationCode);
    }

    try {
      const response = await axios.get(metadataUrl);
      this.logger.info(`Fetched metadata from: ${metadataUrl}`);

      if (response.data) {
        const trackData = response.data;
        return this.createMetadataObject(trackData.eventSongTitle, trackData.eventSongArtist, null, trackData.eventImageUrl);
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch metadata from URL: ${error.message}`);
      // Fallback to show data
      return await this.fetchShowData(stationCode);
    }
  }

  /**
   * Common method to fetch and update metadata
   * @param {string} metadataUrl - The metadata URL
   * @param {string} stationCode - The station code for fallback data
   * @param {string} context - Context for logging (e.g., 'segment', 'EventSource')
   * @returns {Promise<void>}
   */
  async fetchAndUpdateMetadata(metadataUrl, stationCode, context = 'unknown') {
    if (!metadataUrl) {
      return;
    }

    try {
      const metadata = await this.fetchMetadataFromUrl(metadataUrl, stationCode);
      if (metadata && this.onMetadataUpdate) {
        this.logger.info(`Updated metadata from ${context}: ${JSON.stringify(metadata, null, 2)}`);
        this.onMetadataUpdate(metadata);
      }
    } catch (error) {
      this.logger.error(`Failed to fetch metadata from ${context}: ${error.message}`);
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
    const url = `https://listenapi.planetradio.co.uk/api9.2/stations/GB?StationCode%5B%5D=${stationCode}&premium=1`;

    try {
      const response = await axios.get(url);
      this.logger.info('Show data response:', JSON.stringify(response.data, null, 2));

      if (response.data && response.data[0] && response.data[0].stationOnAir) {
        const showData = response.data[0].stationOnAir;
        return this.createMetadataObject(showData.episodeTitle, showData.stationName, null, showData.episodeImageUrl);
      }
      throw new Error('No show data available');
    } catch (error) {
      this.logger.error('Failed to fetch show data:', error.message);
      return this.createMetadataObject('Non stop music', 'Planet Rock', null, null);
    }
  }
}

module.exports = MetadataFetcher;
