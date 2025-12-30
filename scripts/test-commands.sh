#!/bin/bash
# Test script to verify SmartThings commands work correctly
# Usage: ./scripts/test-commands.sh <device-id>

set -e

DEVICE_ID="${1:-4ce5dd8c-0401-b4a2-abe3-54f1b79de771}"

echo "=========================================="
echo "SmartThings Command Test Script"
echo "Device ID: $DEVICE_ID"
echo "=========================================="

echo ""
echo "1. Getting current device status..."
echo "---"
smartthings devices:status "$DEVICE_ID" --json 2>/dev/null | jq '{
  switch: .components.main.switch.switch.value,
  mode: .components.main.airConditionerMode.airConditionerMode.value,
  coolingSetpoint: .components.main.thermostatCoolingSetpoint.coolingSetpoint.value,
  currentTemp: .components.main.temperatureMeasurement.temperature.value
}'

echo ""
echo "2. Test: Set temperature to 72°F via coolingSetpoint..."
echo "---"
smartthings devices:commands "$DEVICE_ID" thermostatCoolingSetpoint:setCoolingSetpoint:72 2>&1
sleep 2

echo ""
echo "3. Verify temperature change..."
echo "---"
smartthings devices:status "$DEVICE_ID" --json 2>/dev/null | jq '.components.main.thermostatCoolingSetpoint.coolingSetpoint'

echo ""
echo "4. Test: Turn device OFF via switch..."
echo "---"
smartthings devices:commands "$DEVICE_ID" switch:off 2>&1
sleep 2

echo ""
echo "5. Verify switch is off..."
echo "---"
smartthings devices:status "$DEVICE_ID" --json 2>/dev/null | jq '.components.main.switch.switch'

echo ""
echo "6. Test: Turn device ON and set to heat mode..."
echo "---"
smartthings devices:commands "$DEVICE_ID" switch:on 2>&1
sleep 1
smartthings devices:commands "$DEVICE_ID" airConditionerMode:setAirConditionerMode:heat 2>&1
sleep 2

echo ""
echo "7. Final status..."
echo "---"
smartthings devices:status "$DEVICE_ID" --json 2>/dev/null | jq '{
  switch: .components.main.switch.switch.value,
  mode: .components.main.airConditionerMode.airConditionerMode.value,
  coolingSetpoint: .components.main.thermostatCoolingSetpoint.coolingSetpoint.value,
  currentTemp: .components.main.temperatureMeasurement.temperature.value
}'

echo ""
echo "=========================================="
echo "Test complete!"
echo "=========================================="
