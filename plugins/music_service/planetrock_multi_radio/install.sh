#!/bin/bash

echo "Installing Planet Rock Radio plugin"

# Install dependencies
npm install

# Copy plugin icon
cp planetrock_radio.svg /volumio/http/www3/assets/images/planetrock_radio.svg

echo "Plugin installed" 