# Use a lightweight Node.js image
FROM node:18

# Set the working directory
WORKDIR /server

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the backend code
COPY . .

# Expose the port (should match the .env PORT
EXPOSE 9000

# Start the backend server
CMD ["npm", "run", "dev"]
