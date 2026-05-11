#!/bin/bash

echo "========================================"
echo "Starting Deployment Script"
echo "========================================"

CURRENT_BRANCH=$(git branch --show-current)

echo "Local Current Branch: $CURRENT_BRANCH"
echo "Connecting to EC2 Server..."

ssh -i "C:\Users\sta\Desktop\chataffy-imp-data\chataffy-key1.pem" ubuntu@34.213.132.47 << EOF

set -e

echo ""
echo "========================================"
echo "Connected to EC2 Successfully"
echo "========================================"

echo "Current Server User:"
whoami

echo ""
echo "Moving to Project Directory..."
cd /var/www/html/chataffy/chataffy

echo "Current Directory:"
pwd

echo ""
echo "Adding Git Safe Directory..."
git config --global --add safe.directory /var/www/html/chataffy/chataffy

echo ""
echo "Checking Current Git Branch on Server..."
git branch --show-current

echo ""
echo "Fetching Latest Code from GitHub..."
git fetch origin

echo ""
echo "Switching to Branch: $CURRENT_BRANCH"
git checkout $CURRENT_BRANCH

echo ""
echo "Resetting Code to Latest Origin Branch..."
git reset --hard origin/$CURRENT_BRANCH

echo ""
echo "Latest Commit Details:"
git log -1

echo ""
echo "Installing Dependencies..."
npm install

echo ""
echo "Restarting PM2 Backend Process..."
pm2 restart backend

echo ""
echo "Checking PM2 Status..."
pm2 status

echo ""
echo "========================================"
echo "Deployment Completed Successfully"
echo "========================================"

EOF

echo ""
echo "SSH Session Closed"
echo "Deployment Script Finished"

exit