#!/bin/bash
gpio_regex="^gpio=([0-9]{1,2},*)+=op,dh"
custom_gpio_conf="gpio=22=op,dh"
if grep -E "${gpio_regex}" /boot/userconfig.txt; then
  sed -i'.bak' -E "s/${gpio_regex}/${custom_gpio_conf}/" /boot/userconfig.txt
else
  echo "${custom_gpio_conf}" >> /boot/userconfig.txt
fi

#requred to end the plugin install
echo "plugininstallend"
