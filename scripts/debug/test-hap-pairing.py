#!/usr/bin/env python3
"""
Automated HAP Pairing Test Script
This script tests if a HAP server is properly accessible for pairing.
Exit code 0 = success (HAP server is working)
Exit code 1 = failure (HAP server is broken)
"""

import sys
import time
import socket
import json
import subprocess
import urllib.request
import urllib.error
from typing import Optional, Dict, Any

# Configuration
HAP_PORT = 51826
WEB_PORT = 3000
TIMEOUT = 10
MAX_RETRIES = 3

def log(message: str, level: str = "INFO"):
    """Log messages with timestamp"""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] [{level}] {message}", file=sys.stderr)

def test_port_open(host: str, port: int, timeout: int = 5) -> bool:
    """Test if a port is open and accepting connections"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except Exception as e:
        log(f"Port test failed for {host}:{port} - {e}", "ERROR")
        return False

def test_mdns_advertisement() -> bool:
    """Test if the HAP service is advertised via mDNS"""
    try:
        # Using dns-sd on macOS to discover HAP services
        cmd = ["dns-sd", "-B", "_hap._tcp", "local."]
        log("Testing mDNS advertisement...", "INFO")

        # Run dns-sd with a timeout
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(3)  # Give it time to discover
        proc.terminate()

        output, error = proc.communicate(timeout=1)

        # Check if we found any HAP services
        if "_hap._tcp" in output:
            log("mDNS advertisement found!", "SUCCESS")

            # HAP-NodeJS adds a suffix to the bridge name (last 4 chars of MAC)
            # Try browsing for any SmartThings Bridge instance
            found_bridge = False
            for line in output.split('\n'):
                if 'SmartThings Bridge' in line:
                    # Extract the full instance name
                    import re
                    match = re.search(r'SmartThings Bridge \w+', line)
                    if match:
                        bridge_name = match.group(0)
                        log(f"Found bridge instance: {bridge_name}", "INFO")

                        # Try to resolve this specific instance
                        cmd = ["dns-sd", "-L", bridge_name, "_hap._tcp", "local."]
                        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                        time.sleep(2)
                        proc.terminate()
                        resolve_output, _ = proc.communicate(timeout=1)

                        if "can be reached at" in resolve_output and "51826" in resolve_output:
                            log(f"Bridge '{bridge_name}' properly advertised on port 51826", "SUCCESS")
                            found_bridge = True
                            break

            if found_bridge:
                return True
            else:
                log("No SmartThings Bridge properly advertised", "WARN")
                return False
        else:
            log("No HAP services found via mDNS", "ERROR")
            return False

    except subprocess.TimeoutExpired:
        # This is actually expected - dns-sd runs continuously
        return True if "_hap._tcp" in output else False
    except Exception as e:
        log(f"mDNS test failed: {e}", "ERROR")
        return False

def test_hap_discovery_endpoint() -> bool:
    """Test the HAP discovery endpoint (HTTP GET /accessories)"""
    try:
        # HAP accessories endpoint should respond even without pairing
        url = f"http://localhost:{HAP_PORT}/accessories"

        req = urllib.request.Request(url)

        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
                # This should fail with 401 or similar if HAP is working
                # (requires pairing)
                status = response.getcode()
                log(f"Unexpected success on /accessories: {status}", "WARN")
                return False
        except urllib.error.HTTPError as e:
            # Expected behavior - should require pairing
            if e.code in [401, 470]:  # 470 is HAP "Connection Authorization Required"
                log(f"HAP server properly requires pairing (code {e.code})", "SUCCESS")
                return True
            else:
                log(f"Unexpected HTTP error: {e.code}", "ERROR")
                return False
        except urllib.error.URLError as e:
            # Connection refused or timeout
            log(f"Cannot connect to HAP server: {e}", "ERROR")
            return False

    except Exception as e:
        log(f"HAP discovery test failed: {e}", "ERROR")
        return False

def test_web_api() -> bool:
    """Test if the web API is responsive"""
    try:
        url = f"http://localhost:{WEB_PORT}/api/homekit/pairing"

        req = urllib.request.Request(url)

        with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
            data = json.loads(response.read().decode())

            # Check for expected fields (API changed to use "pairingCode")
            if "qrCode" in data and ("pairingCode" in data or "setupCode" in data or "pinCode" in data):
                log("Web API pairing endpoint working", "SUCCESS")
                log(f"Pairing info: {json.dumps(data, indent=2)}", "DEBUG")
                return True
            else:
                log(f"Web API returned unexpected data: {data}", "ERROR")
                return False

    except Exception as e:
        log(f"Web API test failed: {e}", "ERROR")
        return False

def test_hap_tcp_connection() -> bool:
    """Test if we can establish a TCP connection to the HAP port"""
    try:
        log(f"Testing TCP connection to HAP port {HAP_PORT}...", "INFO")

        # Test raw TCP connection
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(TIMEOUT)

        result = sock.connect_ex(("localhost", HAP_PORT))

        if result == 0:
            log("TCP connection to HAP port successful", "SUCCESS")

            # Try to send a basic HTTP request
            try:
                sock.send(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
                response = sock.recv(1024)

                if response:
                    log(f"HAP server responded with {len(response)} bytes", "SUCCESS")
                    # Check if it's an HTTP response
                    if b"HTTP" in response:
                        log("HAP server speaks HTTP", "SUCCESS")
                        return True
                    else:
                        log("HAP server response is not HTTP", "ERROR")
                        return False
                else:
                    log("HAP server did not respond", "ERROR")
                    return False
            except socket.timeout:
                log("HAP server connection timed out", "ERROR")
                return False
            finally:
                sock.close()
        else:
            log(f"Cannot connect to HAP port: error code {result}", "ERROR")
            return False

    except Exception as e:
        log(f"TCP connection test failed: {e}", "ERROR")
        return False

def run_all_tests() -> bool:
    """Run all tests and return overall status"""
    log("=" * 50, "INFO")
    log("Starting HAP Pairing Tests", "INFO")
    log("=" * 50, "INFO")

    results = {
        "TCP Connection": False,
        "HAP Discovery": False,
        "Web API": False,
        "mDNS Advertisement": False
    }

    # Test 1: TCP Connection
    log("\nTest 1: TCP Connection to HAP Port", "INFO")
    results["TCP Connection"] = test_hap_tcp_connection()

    # Test 2: HAP Discovery Endpoint
    log("\nTest 2: HAP Discovery Endpoint", "INFO")
    results["HAP Discovery"] = test_hap_discovery_endpoint()

    # Test 3: Web API
    log("\nTest 3: Web API Pairing Endpoint", "INFO")
    results["Web API"] = test_web_api()

    # Test 4: mDNS Advertisement (most important for HomeKit discovery)
    log("\nTest 4: mDNS Advertisement", "INFO")
    results["mDNS Advertisement"] = test_mdns_advertisement()

    # Summary
    log("\n" + "=" * 50, "INFO")
    log("Test Results:", "INFO")
    for test_name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        log(f"  {test_name}: {status}", "INFO" if passed else "ERROR")

    # Overall result - all tests must pass for pairing to work
    all_passed = all(results.values())

    # For git bisect, we need at least TCP and mDNS to work
    critical_passed = results["TCP Connection"] and results["mDNS Advertisement"]

    log("=" * 50, "INFO")
    if all_passed:
        log("✅ All tests passed - HAP server should be pairable", "SUCCESS")
        return True
    elif critical_passed:
        log("⚠️  Critical tests passed but some issues detected", "WARN")
        return True
    else:
        log("❌ Critical tests failed - HAP server is NOT pairable", "ERROR")
        return False

def main():
    """Main entry point"""
    try:
        # Wait a bit for the server to fully start
        log("Waiting for server to stabilize...", "INFO")
        time.sleep(2)

        # Run tests
        success = run_all_tests()

        # Exit with appropriate code for git bisect
        sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        log("\nTests interrupted by user", "WARN")
        sys.exit(130)
    except Exception as e:
        log(f"Unexpected error: {e}", "ERROR")
        sys.exit(1)

if __name__ == "__main__":
    main()