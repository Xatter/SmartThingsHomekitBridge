#!/bin/bash
# Production HAP/mDNS debugging script
# Run this on your production server to diagnose pairing issues

set -e

PRODUCTION_HOST="hvac.pa.revealedpreferences.com"
HAP_PORT_PROD=52826  # Production uses 52826
WEB_PORT_PROD=3000

echo "=================================================="
echo "Production HAP Bridge Debugging"
echo "=================================================="
echo ""

# 1. Check if web interface is accessible
echo "1. Testing web interface..."
if curl -s -f "https://${PRODUCTION_HOST}/api/health" > /dev/null 2>&1; then
    echo "✅ Web interface is accessible via HTTPS"
    curl -s "https://${PRODUCTION_HOST}/api/health" | jq '.' 2>/dev/null || echo "Response received"
else
    echo "❌ Web interface NOT accessible via HTTPS"
fi
echo ""

# 2. Check if HAP port is accessible from external network
echo "2. Testing HAP port ${HAP_PORT_PROD} accessibility..."
if nc -zv ${PRODUCTION_HOST} ${HAP_PORT_PROD} 2>&1 | grep -q succeeded; then
    echo "✅ HAP port ${HAP_PORT_PROD} is OPEN and accessible"
else
    echo "❌ HAP port ${HAP_PORT_PROD} is NOT accessible from external network"
    echo "   This is likely your issue - HomeKit can't reach the HAP port"
fi
echo ""

# 3. Check Docker container status
echo "3. Checking Docker container..."
CONTAINER_NAME="smartthings-homekit-bridge"
if docker ps | grep -q ${CONTAINER_NAME}; then
    echo "✅ Container is running"

    # Check container health
    HEALTH_STATUS=$(docker inspect ${CONTAINER_NAME} --format='{{.State.Health.Status}}' 2>/dev/null || echo "none")
    echo "   Health status: ${HEALTH_STATUS}"

    # Show recent logs
    echo "   Recent logs:"
    docker logs ${CONTAINER_NAME} --tail 10 2>&1 | grep -E "(ERROR|WARN|Bridge|mDNS|HAP|51826|52826)" || true
else
    echo "❌ Container is NOT running"
fi
echo ""

# 4. Check mDNS inside container (if we have access)
echo "4. Testing mDNS inside Docker container..."
docker exec ${CONTAINER_NAME} sh -c 'if command -v avahi-browse >/dev/null 2>&1; then
    timeout 3 avahi-browse -ptr _hap._tcp 2>/dev/null | head -20
elif [ -f /usr/bin/dns-sd ]; then
    timeout 3 dns-sd -B _hap._tcp local. 2>/dev/null | head -20
else
    echo "No mDNS tools available in container"
fi' 2>/dev/null || echo "❌ Cannot test mDNS inside container"
echo ""

# 5. Check network mode
echo "5. Checking Docker network mode..."
NETWORK_MODE=$(docker inspect ${CONTAINER_NAME} --format='{{.HostConfig.NetworkMode}}' 2>/dev/null)
echo "   Network mode: ${NETWORK_MODE}"
if [ "$NETWORK_MODE" = "host" ]; then
    echo "✅ Using host networking (required for mDNS)"
else
    echo "⚠️  NOT using host networking - mDNS might not work!"
fi
echo ""

# 6. Check listening ports inside container
echo "6. Checking ports inside container..."
docker exec ${CONTAINER_NAME} sh -c 'netstat -tuln 2>/dev/null || ss -tuln 2>/dev/null' | grep -E "(3000|51826|52826)" || echo "Cannot check ports"
echo ""

# 7. Test HAP endpoint directly
echo "7. Testing HAP discovery endpoint..."
if curl -f -s -m 5 "http://${PRODUCTION_HOST}:${HAP_PORT_PROD}/accessories" 2>&1 | grep -q "Connection Authorization Required\|401\|470"; then
    echo "✅ HAP server responding correctly (requires pairing)"
else
    echo "❌ HAP server not responding correctly"
fi
echo ""

# 8. Check firewall rules (if accessible)
echo "8. Checking firewall..."
if command -v iptables >/dev/null 2>&1; then
    sudo iptables -L -n | grep -E "(${HAP_PORT_PROD}|${WEB_PORT_PROD})" || echo "No specific firewall rules found for these ports"
else
    echo "Cannot check firewall rules"
fi
echo ""

# 9. Summary and recommendations
echo "=================================================="
echo "DIAGNOSIS SUMMARY"
echo "=================================================="
echo ""
echo "Common issues and solutions:"
echo ""
echo "1. If HAP port is not accessible externally:"
echo "   - Open port ${HAP_PORT_PROD} in your firewall/security groups"
echo "   - Ensure Docker is using --network=host mode"
echo ""
echo "2. If mDNS is not working:"
echo "   - Install avahi-daemon on the host: apt-get install avahi-daemon"
echo "   - Ensure the container is using --network=host"
echo "   - Check for mDNS reflector/repeater if on different subnets"
echo ""
echo "3. If container keeps restarting:"
echo "   - Check logs: docker logs ${CONTAINER_NAME}"
echo "   - Check volume permissions"
echo ""
echo "4. For iPhone to discover the bridge:"
echo "   - iPhone must be on same network/VLAN as server"
echo "   - mDNS (port 5353 UDP) must not be blocked"
echo "   - HAP port (${HAP_PORT_PROD} TCP) must be accessible"
echo ""
echo "=================================================="