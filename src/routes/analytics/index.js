const express = require('express');
const router = express.Router();

router.use('/summary', require('./summary'));
router.use('/revenue', require('./revenue'));
router.use('/staff', require('./staff'));
router.use('/clients', require('./clients'));
router.use('/inventory', require('./inventory'));
router.use('/appointments', require('./appointments'));

module.exports = router;
