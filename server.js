// server.js - Production-ready backend for Live Path Tracker
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS Configuration - Allow all origins
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, '.')));

// Socket.IO Configuration with CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

// ==========================================
// IN-MEMORY DATA STORAGE
// ==========================================
const sessions = new Map();      // sessionId -> session object
const locations = new Map();     // sessionId -> array of locations
const activeConnections = new Map(); // socketId -> sessionId

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

// Clean old sessions (older than 24 hours)
function cleanOldSessions() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  for (const [sessionId, session] of sessions.entries()) {
    const sessionAge = now - new Date(session.startTime).getTime();
    if (sessionAge > maxAge && !session.isActive) {
      sessions.delete(sessionId);
      locations.delete(sessionId);
      console.log(`🗑️ Cleaned old session: ${sessionId}`);
    }
  }
}

// Run cleanup every hour
setInterval(cleanOldSessions, 60 * 60 * 1000);

// ==========================================
// REST API ENDPOINTS
// ==========================================

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Root endpoint - Health check
app.get('/api', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Live Path Tracker Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    stats: {
      activeSessions: sessions.size,
      activeConnections: io.engine.clientsCount,
      totalLocations: Array.from(locations.values()).reduce((sum, arr) => sum + arr.length, 0)
    },
    endpoints: {
      health: 'GET /health',
      sessions: {
        create: 'POST /api/sessions',
        get: 'GET /api/sessions/:sessionId',
        end: 'PUT /api/sessions/:sessionId/end',
        delete: 'DELETE /api/sessions/:sessionId'
      },
      locations: {
        add: 'POST /api/locations',
        get: 'GET /api/sessions/:sessionId/locations',
        latest: 'GET /api/sessions/:sessionId/locations/latest'
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    connections: io.engine.clientsCount,
    sessions: sessions.size
  });
});

// Create new tracking session
app.post('/api/sessions', (req, res) => {
  try {
    const { userId, deviceInfo, appVersion } = req.body;
    
    // Use userId as sessionId if provided (for tracking ID)
    const sessionId = userId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Check if session already exists
    if (sessions.has(sessionId)) {
      const existingSession = sessions.get(sessionId);
      return res.json({
        success: true,
        sessionId,
        session: existingSession,
        message: 'Session already exists'
      });
    }

    const session = {
      sessionId,
      userId: userId || sessionId,
      startTime: new Date().toISOString(),
      endTime: null,
      isActive: true,
      totalDistance: 0,
      metadata: {
        deviceInfo: deviceInfo || 'Unknown',
        appVersion: appVersion || '1.0.0'
      }
    };

    sessions.set(sessionId, session);
    locations.set(sessionId, []);

    console.log(`✅ Session created: ${sessionId}`);

    res.json({
      success: true,
      sessionId,
      session
    });
  } catch (error) {
    console.error('❌ Error creating session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get session information
app.get('/api/sessions/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const sessionLocations = locations.get(sessionId) || [];

    res.json({
      success: true,
      session: {
        ...session,
        locationCount: sessionLocations.length,
        lastUpdate: sessionLocations.length > 0 
          ? sessionLocations[sessionLocations.length - 1].timestamp 
          : null
      }
    });
  } catch (error) {
    console.error('❌ Error getting session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// End tracking session
app.put('/api/sessions/:sessionId/end', (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    session.endTime = new Date().toISOString();
    session.isActive = false;
    sessions.set(sessionId, session);

    console.log(`⏹️ Session ended: ${sessionId}`);

    res.json({
      success: true,
      session
    });
  } catch (error) {
    console.error('❌ Error ending session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete session and its locations
app.delete('/api/sessions/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    sessions.delete(sessionId);
    locations.delete(sessionId);

    console.log(`🗑️ Session deleted: ${sessionId}`);

    res.json({
      success: true,
      message: 'Session and all locations deleted'
    });
  } catch (error) {
    console.error('❌ Error deleting session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add location point
app.post('/api/locations', (req, res) => {
  try {
    const { sessionId, userId, latitude, longitude, accuracy, altitude, speed, heading } = req.body;

    // Validate required fields
    if (!sessionId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sessionId, latitude, longitude'
      });
    }

    // Check if session exists
    let session = sessions.get(sessionId);
    
    // Create session if it doesn't exist
    if (!session) {
      session = {
        sessionId,
        userId: userId || sessionId,
        startTime: new Date().toISOString(),
        endTime: null,
        isActive: true,
        totalDistance: 0,
        metadata: {}
      };
      sessions.set(sessionId, session);
      locations.set(sessionId, []);
      console.log(`✅ Auto-created session: ${sessionId}`);
    }

    if (!session.isActive) {
      return res.status(400).json({
        success: false,
        error: 'Session is not active'
      });
    }

    const location = {
      sessionId,
      userId: userId || sessionId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      accuracy: accuracy ? parseFloat(accuracy) : null,
      altitude: altitude ? parseFloat(altitude) : null,
      speed: speed ? parseFloat(speed) : null,
      heading: heading ? parseFloat(heading) : null,
      timestamp: new Date().toISOString()
    };

    const sessionLocations = locations.get(sessionId) || [];

    // Calculate distance from last location
    if (sessionLocations.length > 0) {
      const lastLocation = sessionLocations[sessionLocations.length - 1];
      const distance = calculateDistance(
        lastLocation.latitude,
        lastLocation.longitude,
        location.latitude,
        location.longitude
      );

      session.totalDistance += distance;
      sessions.set(sessionId, session);
    }

    sessionLocations.push(location);
    locations.set(sessionId, sessionLocations);

    // Broadcast to all connected clients in this session room
    io.to(sessionId).emit('location_update', {
      sessionId,
      location
    });

    console.log(`📍 Location added for session: ${sessionId} (${latitude}, ${longitude})`);

    res.json({
      success: true,
      location,
      totalDistance: session.totalDistance
    });
  } catch (error) {
    console.error('❌ Error adding location:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get location history for a session
app.get('/api/sessions/:sessionId/locations', (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit = 1000, offset = 0 } = req.query;

    const sessionLocations = locations.get(sessionId) || [];
    
    const start = parseInt(offset);
    const end = start + parseInt(limit);
    const paginatedLocations = sessionLocations.slice(start, end);

    res.json({
      success: true,
      count: paginatedLocations.length,
      total: sessionLocations.length,
      locations: paginatedLocations
    });
  } catch (error) {
    console.error('❌ Error getting locations:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get latest location for a session
app.get('/api/sessions/:sessionId/locations/latest', (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionLocations = locations.get(sessionId) || [];

    if (sessionLocations.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No locations found for this session'
      });
    }

    const latestLocation = sessionLocations[sessionLocations.length - 1];

    res.json({
      success: true,
      location: latestLocation
    });
  } catch (error) {
    console.error('❌ Error getting latest location:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==========================================
// WEBSOCKET HANDLERS
// ==========================================

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Join a session room
  socket.on('join_session', (sessionId) => {
    if (!sessionId) {
      socket.emit('error', { message: 'Session ID is required' });
      return;
    }

    socket.join(sessionId);
    activeConnections.set(socket.id, sessionId);
    
    console.log(`✅ Socket ${socket.id} joined session: ${sessionId}`);
    
    socket.emit('joined', { 
      sessionId,
      message: 'Successfully joined session'
    });

    // Send current session info
    const session = sessions.get(sessionId);
    if (session) {
      const sessionLocations = locations.get(sessionId) || [];
      socket.emit('session_info', {
        session,
        locationCount: sessionLocations.length
      });
    }
  });

  // Leave a session room
  socket.on('leave_session', (sessionId) => {
    socket.leave(sessionId);
    activeConnections.delete(socket.id);
    console.log(`👋 Socket ${socket.id} left session: ${sessionId}`);
  });

  // Real-time location update via WebSocket
  socket.on('send_location', (data) => {
    try {
      const { sessionId, latitude, longitude, accuracy, altitude, speed, heading } = data;

      // Validate data
      if (!sessionId || latitude === undefined || longitude === undefined) {
        socket.emit('error', { message: 'Invalid location data' });
        return;
      }

      // Get or create session
      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          sessionId,
          userId: sessionId,
          startTime: new Date().toISOString(),
          endTime: null,
          isActive: true,
          totalDistance: 0,
          metadata: {}
        };
        sessions.set(sessionId, session);
        locations.set(sessionId, []);
        console.log(`✅ Auto-created session via WebSocket: ${sessionId}`);
      }

      if (!session.isActive) {
        socket.emit('error', { message: 'Session is not active' });
        return;
      }

      const location = {
        sessionId,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        accuracy: accuracy ? parseFloat(accuracy) : null,
        altitude: altitude ? parseFloat(altitude) : null,
        speed: speed ? parseFloat(speed) : null,
        heading: heading ? parseFloat(heading) : null,
        timestamp: new Date().toISOString()
      };

      const sessionLocations = locations.get(sessionId) || [];

      // Calculate distance
      if (sessionLocations.length > 0) {
        const lastLocation = sessionLocations[sessionLocations.length - 1];
        const distance = calculateDistance(
          lastLocation.latitude,
          lastLocation.longitude,
          location.latitude,
          location.longitude
        );

        session.totalDistance += distance;
        sessions.set(sessionId, session);
      }

      sessionLocations.push(location);
      locations.set(sessionId, sessionLocations);

      // Broadcast to all clients in the session room
      io.to(sessionId).emit('location_update', {
        sessionId,
        location
      });

      console.log(`📍 WebSocket location: ${sessionId} (${latitude}, ${longitude})`);

    } catch (error) {
      console.error('❌ Error handling WebSocket location:', error);
      socket.emit('error', { message: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    const sessionId = activeConnections.get(socket.id);
    if (sessionId) {
      activeConnections.delete(socket.id);
      console.log(`🔌 Client disconnected: ${socket.id} (was in session: ${sessionId})`);
    } else {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });
});

// ==========================================
// ERROR HANDLING
// ==========================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Global error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('🚀 Live Path Tracker Backend is running!');
  console.log('═══════════════════════════════════════════════');
  console.log(`📍 Server URL: http://localhost:${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('📋 Available endpoints:');
  console.log(`   GET  ${PORT}/              - Frontend App`);
  console.log(`   GET  ${PORT}/health        - Health check`);
  console.log(`   POST ${PORT}/api/sessions  - Create session`);
  console.log(`   POST ${PORT}/api/locations - Add location`);
  console.log('');
  console.log('🔌 WebSocket events:');
  console.log('   - join_session');
  console.log('   - send_location');
  console.log('   - location_update');
  console.log('');
  console.log('✅ Ready to accept connections!');
  console.log('═══════════════════════════════════════════════');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n⚠️ SIGINT received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Export for serverless platforms
module.exports = app;