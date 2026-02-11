const express = require('express');
const router = express.Router();

const { sql, poolPromise } = require('../../db/sql');

/* ---------------------------------------------------
   Date Range Helper
--------------------------------------------------- */
const getDateRange = (range = 'today') => {
  const now = new Date();
  let from, to;

  switch (range) {
    case 'week':
      from = new Date(now);
      from.setDate(now.getDate() - now.getDay());
      to = new Date(from);
      to.setDate(from.getDate() + 6);
      break;

    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;

    case 'year':
      from = new Date(now.getFullYear(), 0, 1);
      to = new Date(now.getFullYear(), 11, 31);
      break;

    default:
      from = new Date(now);
      to = new Date(now);
  }

  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0]
  };
};


/* ---------------------------------------------------
   1️⃣ Appointments Overview
--------------------------------------------------- */
router.get('/overview', async (req, res) => {
  let from, to;

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to = req.query.to;
  } else {
    ({ from, to } = getDateRange(req.query.range || 'today'));
  }

  const diffInDays = Math.ceil((new Date(to) - new Date(from)) / (1000*60*60*24));

  let bucketType;
  let query;

  try {
    const pool = await poolPromise;

    const request = pool.request();
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    // -----------------------------
    // Day bucket
    // -----------------------------
    if (diffInDays <= 31) {
      bucketType = 'day';
      query = `
        SELECT
          CONVERT(date, a.AppointmentDateTime) AS Date,
          COUNT(DISTINCT a.AppointmentId) AS Booked,
          SUM(CASE WHEN a.IsCheckedOut = 1 THEN 1 ELSE 0 END) AS Completed,
          SUM(CASE WHEN a.IsCancellation = 1 OR a.IsDeletedAppointment = 1 THEN 1 ELSE 0 END) AS Cancelled,
          SUM(CASE WHEN a.IsNoShow = 1 THEN 1 ELSE 0 END) AS NoShow
        FROM dbo.scvAppointmentAll a
        WHERE a.AppointmentDateTime >= @from
          AND a.AppointmentDateTime < DATEADD(DAY, 1, @to)
        GROUP BY CONVERT(date, a.AppointmentDateTime)
        ORDER BY Date;
      `;
    } 
    // -----------------------------
    // Week bucket
    // -----------------------------
    else if (diffInDays <= 90) {
      bucketType = 'week';
      query = `
        WITH WeeklyBuckets AS (
          SELECT
            DATEADD(DAY, (DATEDIFF(DAY, @from, a.AppointmentDateTime)/7)*7, @from) AS BucketStart,
            a.AppointmentId,
            a.IsCheckedOut,
            a.IsCancellation,
            a.IsDeletedAppointment,
            a.IsNoShow
          FROM dbo.scvAppointmentAll a
          WHERE a.AppointmentDateTime >= @from
            AND a.AppointmentDateTime < DATEADD(DAY, 1, @to)
        )
        SELECT
          CONCAT(FORMAT(BucketStart,'dd MMM'), ' – ', FORMAT(DATEADD(DAY,6,BucketStart),'dd MMM')) AS DateLabel,
          COUNT(DISTINCT AppointmentId) AS Booked,
          SUM(CASE WHEN IsCheckedOut = 1 THEN 1 ELSE 0 END) AS Completed,
          SUM(CASE WHEN IsCancellation = 1 OR IsDeletedAppointment = 1 THEN 1 ELSE 0 END) AS Cancelled,
          SUM(CASE WHEN IsNoShow = 1 THEN 1 ELSE 0 END) AS NoShow
        FROM WeeklyBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;
    }
    // -----------------------------
    // 15-day bucket
    // -----------------------------
    else if (diffInDays <= 180) {
      bucketType = '15-days';
      query = `
        WITH FifteenDayBuckets AS (
          SELECT
            DATEADD(DAY, (DATEDIFF(DAY, @from, a.AppointmentDateTime)/15)*15, @from) AS BucketStart,
            a.AppointmentId,
            a.IsCheckedOut,
            a.IsCancellation,
            a.IsDeletedAppointment,
            a.IsNoShow
          FROM dbo.scvAppointmentAll a
          WHERE a.AppointmentDateTime >= @from
            AND a.AppointmentDateTime < DATEADD(DAY, 1, @to)
        )
        SELECT
          CONCAT(FORMAT(BucketStart,'dd MMM'), ' – ', FORMAT(DATEADD(DAY,14,BucketStart),'dd MMM')) AS DateLabel,
          COUNT(DISTINCT AppointmentId) AS Booked,
          SUM(CASE WHEN IsCheckedOut = 1 THEN 1 ELSE 0 END) AS Completed,
          SUM(CASE WHEN IsCancellation = 1 OR IsDeletedAppointment = 1 THEN 1 ELSE 0 END) AS Cancelled,
          SUM(CASE WHEN IsNoShow = 1 THEN 1 ELSE 0 END) AS NoShow
        FROM FifteenDayBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;
    } 
    // -----------------------------
    // Month bucket
    // -----------------------------
    else {
      bucketType = 'month';
      query = `
        WITH MonthlyBuckets AS (
          SELECT
            DATEFROMPARTS(YEAR(a.AppointmentDateTime), MONTH(a.AppointmentDateTime), 1) AS BucketStart,
            a.AppointmentId,
            a.IsCheckedOut,
            a.IsCancellation,
            a.IsDeletedAppointment,
            a.IsNoShow
          FROM dbo.scvAppointmentAll a
          WHERE a.AppointmentDateTime >= @from
            AND a.AppointmentDateTime < DATEADD(DAY, 1, @to)
        )
        SELECT
          FORMAT(BucketStart,'MMM yyyy') AS DateLabel,
          COUNT(DISTINCT AppointmentId) AS Booked,
          SUM(CASE WHEN IsCheckedOut = 1 THEN 1 ELSE 0 END) AS Completed,
          SUM(CASE WHEN IsCancellation = 1 OR IsDeletedAppointment = 1 THEN 1 ELSE 0 END) AS Cancelled,
          SUM(CASE WHEN IsNoShow = 1 THEN 1 ELSE 0 END) AS NoShow
        FROM MonthlyBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;
    }

    const result = await request.query(query);

    res.json({
      bucket: bucketType,
      data: result.recordset
    });

  } catch (err) {
    console.error('Appointments overview error:', err);
    res.status(500).json({ error: 'Failed to load appointment overview' });
  }
});

/* ---------------------------------------------------
   2️⃣ Peak Hours
--------------------------------------------------- */
router.get('/peak-hours', async (req, res) => {
  let from, to;

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to = req.query.to;
  } else {
    ({ from, to } = getDateRange(req.query.range || 'today'));
  }

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    const result = await request.query(`
      SELECT
        DATEPART(HOUR, a.AppointmentDateTime) AS Hour,
        COUNT(DISTINCT a.AppointmentId) AS Appointments
      FROM dbo.scvAppointmentAll a
      WHERE
        a.AppointmentDateTime >= @from
        AND a.AppointmentDateTime < DATEADD(DAY, 1, @to)
      GROUP BY DATEPART(HOUR, a.AppointmentDateTime)
      ORDER BY Hour;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Peak hours error:', err);
    res.status(500).json({ error: 'Failed to load peak hours data' });
  }
});

module.exports = router;
