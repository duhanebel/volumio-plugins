'use strict';

var libQ = require('kew');
var axios = require('axios');

class AuthManager {
  constructor(logger) {
    this.logger = logger;
    this.csrfToken = null;
    this.sessionCookie = null;
    this.userId = null;
    this.jwtExpiry = null;
  }

  /**
   * Main authentication method
   * @param {string} username - User's email/username
   * @param {string} password - User's password
   * @returns {Promise<string>} - Returns the user ID on successful authentication
   */
  authenticate(username, password) {
    const self = this;
    const defer = libQ.defer();

    if (!username || !password) {
      defer.reject(new Error('Username and password are required'));
      return defer.promise;
    }

    // Check if already authenticated and token is still valid
    if (self.isAuthenticated()) {
      self.logger.info('User already authenticated, returning existing user ID');
      defer.resolve(self.userId);
      return defer.promise;
    }

    self.logger.info('Starting authentication process');

    // First get the CSRF token
    self._getCsrfToken()
      .then(csrfData => {
        return self._performLogin(username, password, csrfData);
      })
      .then(() => {
        self.logger.info('Authentication successful, user ID: ' + self.userId);
        defer.resolve(self.userId);
      })
      .catch(error => {
        self.logger.error('Authentication failed: ' + error.message);
        defer.reject(error);
      });

    return defer.promise;
  }

  /**
   * Check if user is authenticated and token is not expired
   * @returns {boolean} - True if authenticated and token is valid
   */
  isAuthenticated() {
    if (!this.userId || !this.sessionCookie) {
      return false;
    }

    // Check if JWT token is expired
    if (this.jwtExpiry && Date.now() > this.jwtExpiry) {
      this.logger.info('JWT token has expired, clearing authentication state');
      this._clearAuthState();
      return false;
    }

    return true;
  }

  /**
   * Get the current user ID
   * @returns {string|null} - User ID if authenticated, null otherwise
   */
  getUserId() {
    return this.isAuthenticated() ? this.userId : null;
  }

  /**
   * Get the session cookie for API requests
   * @returns {string|null} - Session cookie if authenticated, null otherwise
   */
  getSessionCookie() {
    return this.isAuthenticated() ? this.sessionCookie : null;
  }

  /**
   * Clear all authentication state
   */
  clearAuth() {
    this._clearAuthState();
    this.logger.info('Authentication state cleared');
  }

  /**
   * Get CSRF token from the authentication endpoint
   * @private
   * @returns {Promise<Object>} - CSRF token data
   */
  _getCsrfToken() {
    const self = this;
    
    self.logger.info('Making CSRF token request to: https://account.planetradio.co.uk/ajax/process-account/');
    
    return axios.post('https://account.planetradio.co.uk/ajax/process-account/')
      .then(response => {
        self.logger.info('CSRF Response Status: ' + response.status);
        self.logger.info('CSRF Response Headers: ' + JSON.stringify(response.headers, null, 2));
        self.logger.info('CSRF Response Body: ' + JSON.stringify(response.data, null, 2));

        // Get CSRF token from header
        const csrfHeader = response.headers['x-csrf-token'];
        if (!csrfHeader) {
          throw new Error('Could not find CSRF token in headers');
        }

        try {
          const csrfData = JSON.parse(csrfHeader);
          if (!csrfData.csrf_name || !csrfData.csrf_value) {
            throw new Error('Invalid CSRF token format');
          }

          return {
            csrfData: csrfData,
            cookies: response.headers['set-cookie']
          };
        } catch (error) {
          self.logger.error('Failed to parse CSRF token: ' + error.message);
          throw error;
        }
      });
  }

  /**
   * Perform login with credentials and CSRF token
   * @private
   * @param {string} username - User's email/username
   * @param {string} password - User's password
   * @param {Object} csrfInfo - CSRF token data and cookies
   * @returns {Promise<void>}
   */
  _performLogin(username, password, csrfInfo) {
    const self = this;
    
    const loginData = {
      'processmode': 'login',
      'emailfield': encodeURIComponent(username).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A'),
      'passwordfield': encodeURIComponent(password).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A'),
      'authMethod': 'native',
      'csrf_name': csrfInfo.csrfData.csrf_name,
      'csrf_value': csrfInfo.csrfData.csrf_value
    };

    // Convert to form-urlencoded format
    const formData = Object.keys(loginData)
      .map(key => key + '=' + loginData[key])
      .join('&');

    self.logger.info('Making login request with form data: ' + formData);
    self.logger.info('Login request headers: ' + JSON.stringify({
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-Token': JSON.stringify(csrfInfo.csrfData),
      'Cookie': csrfInfo.cookies
    }, null, 2));

    return axios.post('https://account.planetradio.co.uk/ajax/process-account/', formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': JSON.stringify(csrfInfo.csrfData),
        'Cookie': csrfInfo.cookies
      }
    })
    .then(loginResponse => {
      self.logger.info('Login Response Status: ' + loginResponse.status);
      self.logger.info('Login Response Headers: ' + JSON.stringify(loginResponse.headers, null, 2));
      self.logger.info('Login Response Body: ' + JSON.stringify(loginResponse.data, null, 2));

      if (loginResponse.data && loginResponse.data.status === 601) {
        self.csrfToken = csrfInfo.csrfData.csrf_value;
        
        // Find the specific JWT cookie we need
        const cookies = loginResponse.headers['set-cookie'];
        let jwtCookie = null;
        
        if (Array.isArray(cookies)) {
          jwtCookie = cookies.find(function(cookie) {
            return cookie.startsWith('jwt-radio-uk-sso-uk_radio=') && !cookie.includes('deleted');
          });
        }
        
        if (!jwtCookie) {
          throw new Error('Could not find valid JWT cookie in response');
        }

        self.sessionCookie = jwtCookie;

        // Extract user ID from JWT token
        const jwtPayload = self._extractJwtPayload([jwtCookie]);
        if (jwtPayload && jwtPayload.id) {
          self.userId = jwtPayload.id;
          self.jwtExpiry = jwtPayload.exp ? jwtPayload.exp * 1000 : null; // Convert to milliseconds
          self.logger.info('Successfully extracted user ID: ' + self.userId);
          if (self.jwtExpiry) {
            self.logger.info('JWT token expires at: ' + new Date(self.jwtExpiry).toISOString());
          }
          return;
        } else {
          throw new Error('Failed to extract user ID from JWT token');
        }
      } else {
        throw new Error('Login failed: ' + JSON.stringify(loginResponse.data));
      }
    });
  }

  /**
   * Extract JWT payload from cookies
   * @private
   * @param {Array} cookies - Array of cookie strings
   * @returns {Object|null} - JWT payload or null if invalid
   */
  _extractJwtPayload(cookies) {
    if (!cookies) return null;

    // Find the JWT cookie
    const jwtCookie = cookies.find(function(cookie) {
      return cookie.startsWith('jwt-radio-uk-sso-uk_radio=');
    });

    if (!jwtCookie) return null;

    // Extract the JWT token value
    const jwtToken = jwtCookie.split('=')[1].split(';')[0];

    try {
      // JWT tokens are base64url encoded and have three parts separated by dots
      const parts = jwtToken.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
      }

      // Decode the payload (second part)
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      return payload;
    } catch (error) {
      this.logger.error('Failed to parse JWT token: ' + error.message);
      return null;
    }
  }

  /**
   * Clear all authentication state
   * @private
   */
  _clearAuthState() {
    this.csrfToken = null;
    this.sessionCookie = null;
    this.userId = null;
    this.jwtExpiry = null;
  }
}

module.exports = AuthManager; 