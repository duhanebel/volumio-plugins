'use strict';

const axios = require('axios');

class StationManager {
  constructor(logger) {
    this.logger = logger;
    this.baseUrl = 'https://listenapi.planetradio.co.uk/api9.2';
    this.stationsCache = null; // Cache for station list with streamUrl included
  }

  /**
   * Helper function to find a station in the cache by station code
   * @private
   * @param {string} stationCode - The station code to find
   * @returns {Object|null} - The cached station object or null if not found
   */
  _findCachedStation(stationCode) {
    if (!this.stationsCache || !stationCode) {
      return null;
    }
    return this.stationsCache.find(item => item.stationCode === stationCode);
  }

  /**
   * Helper function to safely parse a URL string into a URL object
   * @private
   * @param {string} urlString - The URL string to parse
   * @returns {URL|null} - The parsed URL object or null if parsing fails
   */
  _parseUrl(urlString) {
    if (!urlString) {
      return null;
    }

    try {
      return new URL(urlString);
    } catch (error) {
      this.logger.warn(`Failed to parse URL: ${urlString} - ${error.message}`);
      return null;
    }
  }

  /**
   * Get all stations for the root content
   * @param {boolean} forceRefresh - Force refresh the cache (default: false)
   * @returns {Promise<Array>} - Array of station objects formatted for Volumio UI
   */
  async getStations(forceRefresh = true) {
    const self = this;

    // Clear cache if force refresh is requested
    if (forceRefresh) {
      self.logger.info('Force refresh requested, clearing station cache');
      self.stationsCache = null;
    }

    // Check if we have cached stations
    if (self.stationsCache) {
      self.logger.info('Returning cached stations');
      return self.stationsCache;
    }

    self.logger.info(`Fetching stations from: ${self.baseUrl}/initweb/pln`);

    try {
      // Fetch main station info
      const response = await axios.get(`${self.baseUrl}/initweb/pln`);

      if (!response.data) {
        throw new Error('No station data in API response');
      }

      const mainStation = response.data; // main station is the root object
      const brandId = mainStation.stationBrandId;
      const stations = [mainStation];

      // Add related stations with the same brandId
      if (Array.isArray(response.data.stationBrandRelated)) {
        response.data.stationBrandRelated.forEach(station => {
          if (station.stationBrandId === brandId) {
            stations.push(station);
          }
        });
      }

      // Build items for Volumio UI
      const items = stations.map(station => {
        // For all stations, use custom URI for on-demand resolution
        const uri = `planetradio/${station.stationCode}`;

        // Extract streamUrl for the main station (pln) if available
        let streamUrl = null;
        if (station.stationCode === 'pln' && Array.isArray(station.stationStreams)) {
          const stream = station.stationStreams.find(s => s.streamQuality === 'hq' && s.streamPremium === true);
          if (stream) {
            // Parse the stream URL and store as URL object
            streamUrl = self._parseUrl(stream.streamUrl);
            if (streamUrl) {
              self.logger.info(`[getStations] Extracted streamUrl for main station (pln): ${streamUrl.toString()}`);
            } else {
              self.logger.warn(`[getStations] Failed to parse streamUrl for main station (pln): ${stream.streamUrl}`);
            }
          }
        }

        return {
          service: 'planet_radio',
          type: 'mywebradio',
          title: station.stationName,
          artist: station.stationStrapline,
          album: null,
          icon: 'fa fa-music',
          uri,
          streamType: 'aac',
          stationCode: station.stationCode,
          streamUrl, // Will be populated for main station, null for others
          albumart: station.stationSquareLogo,
        };
      });

      // Cache the stations
      self.stationsCache = items;
      self.logger.info(`Cached ${items.length} stations`);

      return items;
    } catch (error) {
      self.logger.error(`Failed to fetch stations: ${error}`);
      throw error;
    }
  }

  /**
   * Get streaming URL for a specific station
   * @param {string} stationCode - The station code (e.g., 'pln', 'kerrang', etc.)
   * @returns {Promise<Object>} - streamUrl (URL objects)
   */
  async getStreamingURL(stationCode) {
    const self = this;

    if (!stationCode) {
      throw new Error('Station code is required');
    }

    // Check if we have cached streamUrl for this station
    const cachedStation = self._findCachedStation(stationCode);
    if (cachedStation && cachedStation.streamUrl) {
      self.logger.info(`[getStreamingURL] Returning cached streamUrl for stationCode: ${stationCode}`);
      return cachedStation.streamUrl;
    }

    self.logger.info(`[getStreamingURL] Resolving stream for stationCode: ${stationCode}`);

    try {
      const response = await axios.get(`${self.baseUrl}/initweb/${stationCode}`);
      const station = response.data;
      let streamUrl = null;

      if (Array.isArray(station.stationStreams)) {
        self.logger.info(`[getStreamingURL] stationStreams for ${stationCode}: ${JSON.stringify(station.stationStreams, null, 2)}`);

        const stream = station.stationStreams.find(s => s.streamQuality === 'hq' && s.streamPremium === true);

        self.logger.info(`[getStreamingURL] Stream search result for ${stationCode}: ${JSON.stringify(stream, null, 2)}`);

        if (stream) {
          // Parse the stream URL and store as URL object
          streamUrl = self._parseUrl(stream.streamUrl);
          if (!streamUrl) {
            self.logger.error(`[getStreamingURL] Failed to parse streamUrl for station ${stationCode}: ${stream.streamUrl}`);
            throw new Error(`Failed to parse stream URL for station ${stationCode}`);
          }
        }
      }

      if (!streamUrl) {
        self.logger.error(`[getStreamingURL] No suitable stream found for station ${stationCode}`);
        throw new Error(`No suitable stream found for station ${stationCode}`);
      }

      // Cache the streamUrl in the stationsCache
      if (cachedStation) {
        cachedStation.streamUrl = streamUrl;
        self.logger.info(`[getStreamingURL] Cached streamUrl for stationCode: ${stationCode}`);
      }

      return streamUrl;
    } catch (error) {
      self.logger.error(`[getStreamingURL] Failed to resolve station stream: ${error}`);
      throw error;
    }
  }

  /**
   * Get station info for a specific station code
   * @param {string} stationCode - The station code
   * @returns {Promise<Object>} - Station information
   */
  async getStationInfo(stationCode) {
    const self = this;

    if (!stationCode) {
      throw new Error('Station code is required');
    }

    // Check if we have cached station info
    const cachedStation = self._findCachedStation(stationCode);
    if (cachedStation) {
      self.logger.info(`[getStationInfo] Returning cached info for station: ${stationCode}`);
      return {
        name: cachedStation.title,
        code: stationCode,
        albumart: cachedStation.albumart,
      };
    }

    self.logger.info(`[getStationInfo] Fetching info for station: ${stationCode}`);

    try {
      const response = await axios.get(`${self.baseUrl}/initweb/${stationCode}`);
      const station = response.data;

      return {
        name: station.stationName,
        code: stationCode,
        stationStrapline: station.stationStrapline,
        albumart: station.stationSquareLogo,
      };
    } catch (error) {
      self.logger.error(`[getStationInfo] Failed to fetch station info: ${error}`);
      throw error;
    }
  }

  /**
   * Add authentication parameters to a stream URL
   * @param {URL} streamUrl - The base stream URL object
   * @param {string} userId - User ID for authentication
   * @returns {URL} - Stream URL object with authentication parameters
   */
  addAuthParameters(streamUrl, userId) {
    if (!streamUrl) {
      return streamUrl;
    }

    // Create a copy of the URL to avoid modifying the original
    const url = new URL(streamUrl.toString());
    const existingParams = new URLSearchParams(url.search);

    // Prepare authentication parameters
    const currentEpoch = Math.floor(Date.now() / 1000);
    const authParams = {
      direct: 'false',
      listenerid: userId,
      'aw_0_1st.bauer_listenerid': userId,
      'aw_0_1st.playerid': 'BMUK_inpage_html5',
      'aw_0_1st.skey': currentEpoch.toString(),
      'aw_0_1st.bauer_loggedin': 'true',
      user_id: userId,
      'aw_0_1st.bauer_user_id': userId,
      region: 'GB',
    };

    // Add authentication parameters to existing ones
    Object.keys(authParams).forEach(key => {
      existingParams.set(key, authParams[key]);
    });

    // Reconstruct the URL with all parameters
    url.search = existingParams.toString();

    this.logger.info('Added authentication parameters to stream URL');
    this.logger.info(`Authenticated stream URL: ${url.toString()}`);

    return url;
  }
}

module.exports = StationManager;
