#!/bin/bash
gpio_regex="^gpio=([0-9]{1,2},*)+=op,dh"
if grep -E "${gpio_regex}" /boot/userconfig.txt; then
  sed -i'.bak' -E "s/${gpio_regex}//" /boot/userconfig.txt
fi

echo "Done"
