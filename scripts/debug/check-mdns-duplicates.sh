#!/bin/bash
# Script to find and test all SmartThings Bridge mDNS entries

echo "=================================================="
echo "Checking for duplicate SmartThings Bridges"
echo "=================================================="
echo ""

# Discover all bridges
echo "1. Discovering all SmartThings Bridges via mDNS..."
timeout 3 dns-sd -B _hap._tcp local. 2>&1 | grep -i "smartthings bridge" | tee /tmp/bridges.txt
echo ""

# Extract unique bridge names
BRIDGES=$(cat /tmp/bridges.txt | sed -E 's/.*SmartThings Bridge ([A-F0-9]+).*/SmartThings Bridge \1/g' | sort -u)

echo "2. Found these unique bridge instances:"
echo "$BRIDGES"
echo ""

# Test each bridge
echo "3. Testing each bridge for connectivity..."
echo ""

while IFS= read -r bridge; do
    echo "Testing: $bridge"

    # Try to resolve the bridge
    echo -n "  Resolving via mDNS... "
    OUTPUT=$(timeout 3 dns-sd -L "$bridge" _hap._tcp local. 2>&1)

    if echo "$OUTPUT" | grep -q "can be reached at"; then
        # Extract hostname and port
        HOSTNAME=$(echo "$OUTPUT" | grep "can be reached at" | sed -E 's/.*can be reached at ([^ ]+).*/\1/' | cut -d: -f1)
        PORT=$(echo "$OUTPUT" | grep "can be reached at" | sed -E 's/.*:([0-9]+).*/\1/')

        echo "Found at $HOSTNAME:$PORT"

        # Extract IP if it's in the output
        IP=$(echo "$OUTPUT" | grep -oE "([0-9]{1,3}\.){3}[0-9]{1,3}" | head -1)
        if [ -n "$IP" ]; then
            echo "  IP Address: $IP"
        fi

        # Extract the id field (MAC address)
        MAC=$(echo "$OUTPUT" | grep -o 'id=[A-F0-9:]*' | cut -d= -f2)
        if [ -n "$MAC" ]; then
            echo "  Bridge ID: $MAC"
        fi

        # Try to connect to the port
        echo -n "  Testing HAP port... "
        if [ -n "$IP" ] && [ -n "$PORT" ]; then
            if timeout 2 nc -zv $IP $PORT 2>/dev/null; then
                echo "✅ Port $PORT is OPEN on $IP"

                # Test HAP endpoint
                echo -n "  Testing HAP endpoint... "
                RESPONSE=$(curl -s -w "%{http_code}" http://$IP:$PORT/accessories 2>&1 | tail -1)
                if [ "$RESPONSE" = "470" ]; then
                    echo "✅ HAP responding correctly (auth required)"
                    echo "  🎯 THIS IS A LIVE BRIDGE"
                else
                    echo "❌ Unexpected response: $RESPONSE"
                fi
            else
                echo "❌ Port $PORT is CLOSED on $IP"
                echo "  ⚠️  STALE mDNS ENTRY - Bridge not actually running!"
            fi
        else
            echo "Could not determine IP/Port"
        fi
    else
        echo "❌ Could not resolve via mDNS"
        echo "  ⚠️  STALE mDNS ENTRY"
    fi

    echo ""
done <<< "$BRIDGES"

echo "=================================================="
echo "4. Checking for local bridge on this machine..."
echo "=================================================="
echo ""

# Check local ports
echo "Local port check:"
echo -n "  Port 51826: "
nc -zv localhost 51826 2>&1 | grep -o "succeeded\|refused" || echo "closed"
echo -n "  Port 52826: "
nc -zv localhost 52826 2>&1 | grep -o "succeeded\|refused" || echo "closed"

echo ""
echo "=================================================="
echo "5. To clean up stale mDNS entries:"
echo "=================================================="
echo ""
echo "On your Mac (clears mDNS cache):"
echo "  sudo dscacheutil -flushcache"
echo "  sudo killall -HUP mDNSResponder"
echo ""
echo "On Linux:"
echo "  sudo systemctl restart avahi-daemon"
echo ""
echo "On the server (192.168.2.2), restart with fresh identity:"
echo "  docker stop smartthings_homekit_bridge"
echo "  docker rm smartthings_homekit_bridge"
echo "  # Remove persist directory to clear old pairing"
echo "  rm -rf /volume1/docker/smartthings-homekit-bridge/persist/*"
echo "  # Start with new MAC"
echo "  docker run ... -e HAP_BRIDGE_USERNAME='CC:22:3D:E3:CE:F9' ..."
echo ""
echo "=================================================="