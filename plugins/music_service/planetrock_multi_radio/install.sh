#!/bin/bash

echo "Installing Planet Rock Multi Radio plugin"

# Install dependencies
npm install

# Copy plugin icon
cp planetrock_multi_radio.svg /volumio/http/www3/assets/images/planetrock_multi_radio.svg

echo "Plugin installed" 