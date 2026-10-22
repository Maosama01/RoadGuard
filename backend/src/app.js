'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { optionalAuth } = require('./auth');
const { publicPage } = require('./publicPage');

function createApp(db, { logging = true } = {}) {
  const app = express();
  // Browser-side HTTPS rules (HSTS, upgrading http requests) only when the server's public
  // address is https. On http over the LAN they would leave the dashboard blank.
  const httpsOnly = config.publicBaseUrl.startsWith('https://');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      strictTransportSecurity: httpsOnly,
      crossOriginOpenerPolicy: httpsOnly ? { policy: 'same-origin' } : false,
      originAgentCluster: httpsOnly,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://*.basemaps.cartocdn.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: httpsOnly ? [] : null,
        },
      },
    })
  );
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  if (logging) app.use(morgan('dev'));
  app.use(optionalAuth(db));

  const baseUrlOf = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;

  app.get('/api/health', (_req, res) => res.json({ success: true, service: 'roadguard', time: Date.now() }));
  app.use('/api/auth', require('./routes/auth')(db));
  app.use('/api/reports', require('./routes/reports')(db, baseUrlOf));
  app.use('/api/hazards', require('./routes/hazards')(db, baseUrlOf));
  app.use('/api/stats', require('./routes/stats')(db));
  app.use('/api', require('./routes/pocket')(db));
  app.use('/api', require('./routes/accountability')(db));

  // Public, shareable hazard pages (server-rendered, no scripts).
  app.get('/h/:id', publicPage(db, baseUrlOf));
  app.use('/site', express.static(path.join(__dirname, '..', 'public', 'site'), { maxAge: '1d' }));

  app.use('/uploads', express.static(config.uploadDir, { maxAge: '7d', fallthrough: false }));

  // Authority dashboard + its vendored map libraries (no CDN needed).
  const nm = path.join(__dirname, '..', 'node_modules');
  app.use('/vendor/leaflet', express.static(path.join(nm, 'leaflet', 'dist')));
  app.use('/vendor/leaflet-heat', express.static(path.join(nm, 'leaflet.heat', 'dist')));
  app.use('/vendor/fonts/barlow', express.static(path.join(nm, '@fontsource', 'barlow', 'files')));
  app.use('/vendor/fonts/barlow-condensed', express.static(path.join(nm, '@fontsource', 'barlow-condensed', 'files')));
  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err && err.status === 404) return res.status(404).json({ success: false, message: 'Not found.' });
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, message: 'Request body is not valid JSON.' });
    }
    console.error(err);
    res.status(500).json({ success: false, message: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
