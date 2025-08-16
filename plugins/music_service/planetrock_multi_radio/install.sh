#!/bin/bash

echo "Installing Planet Radio plugin"

# Install dependencies
npm install

# Copy plugin icon
cp assets/planet_radio.webp /volumio/http/www3/assets/images/planet_radio.webp

echo "Plugin installed" 