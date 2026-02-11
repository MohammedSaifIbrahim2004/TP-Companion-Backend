const express = require('express');
const router = express.Router();

const { sql, poolPromise } = require('../../db/sql');

router.get('/', async (req, res) => {
  let { from, to } = req.query;

  // Default to today
  const today = new Date().toISOString().split('T')[0];
  from = from || today;
  to = to || today;

  try {
    const pool = await poolPromise;


    /* ---------------- REVENUE ---------------- */
    const revenueReq = pool.request();
    revenueReq.input('from', sql.Date, from);
    revenueReq.input('to', sql.Date, to);

    const revenueResult = await revenueReq.query(`
      SELECT 
    ISNULL(
        SUM(
            CASE 
                WHEN ISNULL(h.TransactionType, 1) = 3 THEN -ABS(h.Amount)  -- refunds
                WHEN ISNULL(h.TransactionType, 1) = 1 AND h.ItemType <> 4 THEN h.Amount  -- normal sales, exclude tips
                ELSE 0
            END
        ), 0
    ) AS Revenue
FROM dbo.historys h
WHERE h.Date >= @from
  AND h.Date < DATEADD(DAY, 1, @to);

    `);

    /* ---------------- APPOINTMENTS ---------------- */
    const appointReq = pool.request();
    appointReq.input('from', sql.Date, from);
    appointReq.input('to', sql.Date, to);

    const appointResult = await appointReq.query(`
      SELECT COUNT(DISTINCT AppointmentId) AS Appointments
FROM (
    -- Live appointments
    SELECT 
        Id AS AppointmentId,
        DATEADD(MINUTE, ([Time] / 100 * 60) + ([Time] % 100), [Date]) AS AppointmentDateTime
    FROM dbo.appoints
    WHERE Client IS NOT NULL 
      AND Client >= 10

    UNION ALL

    -- Deleted or modified appointments from log
    SELECT 
        al.AppointmentId,
        DATEADD(MINUTE, (al.[Time] / 100 * 60) + (al.[Time] % 100), al.[Date]) AS AppointmentDateTime
    FROM dbo.AppointsLog al
    WHERE al.AppointmentId NOT IN (SELECT Id FROM dbo.appoints)
      AND al.ClientId IS NOT NULL 
      AND al.ClientId >= 10
      AND al.AppointsLogId = (
          SELECT MAX(AppointsLogId) 
          FROM dbo.AppointsLog 
          WHERE AppointmentId = al.AppointmentId
      )
) AS AllAppointments
WHERE AppointmentDateTime >= @from
  AND AppointmentDateTime < DATEADD(DAY, 1, @to);



    `);

    /* ---------------- CLIENTS ---------------- */
    const clientReq = pool.request();
    clientReq.input('from', sql.Date, from);
    clientReq.input('to', sql.Date, to);

    const clientResult = await clientReq.query(`
      SELECT ISNULL(COUNT(DISTINCT h.ClientIdNumber), 0) AS Clients
      FROM dbo.historys h
      WHERE 
          h.Date >= @from 
          AND h.Date < DATEADD(DAY, 1, @to)
          AND ISNULL(h.TransactionType, 1) = 1
          AND h.ClientIdNumber NOT IN (2, 8);  -- exclude clients with ID 2 and 8
    `);

    res.json({
      revenue: revenueResult.recordset[0].Revenue,
      appointments: appointResult.recordset[0].Appointments,
      clients: clientResult.recordset[0].Clients
    });

  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to load summary analytics' });
  }
});

module.exports = router;
