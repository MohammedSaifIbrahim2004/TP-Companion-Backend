const express = require('express');
const router = express.Router();

const { sql ,poolPromise } = require('../../db/sql');

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
    default: // today
      from = new Date(now);
      to = new Date(now);
  }

  return {
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0]
  };
};

/* ---------------------------------------------------
   1️⃣ New vs Returning Clients
--------------------------------------------------- */
router.get('/new-vs-returning', async (req, res) => {
  let from, to;

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to = req.query.to;
  } else {
    const range = req.query.range || 'today';
    ({ from, to } = getDateRange(range));
  }

  // console.log('NewVsReturning range:', from, to);

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.timeout = 300000; // 5 minutes
    request.input('From', sql.VarChar, from); // send as string
    request.input('To', sql.VarChar, to);     // send as string

    const result = await request.query(`
   ;WITH ValidSales AS (
    SELECT
        stl.ClientId,
        stl.TransactionNumber,
        CAST(stl.TransactionDate AS DATE) AS VisitDate
    FROM scvSaleTransactionLine2 stl
    INNER JOIN scvTransactionType stt
        ON stt.TransactionType = stl.TransactionType
       AND stt.IsSale = 1
    WHERE stl.SiteId = 0
      AND stl.TransactionDate BETWEEN CAST(@From AS DATE) AND DATEADD(DAY,1,CAST(@To AS DATE))
      AND stl.VoidStatusStringCode = 'VoidStatus.Normal'
      AND stl.ClientId NOT IN (1,2,8,9)
      AND ISNULL(stl.ItemType,0) NOT IN (7,10)
      AND ISNULL(stl.ItemSubTypeCode,0) <> 11
),

VisitPerTicket AS (
    SELECT
        ClientId,
        TransactionNumber,
        VisitDate
    FROM ValidSales
    GROUP BY ClientId, TransactionNumber, VisitDate
),

ClientsInRange AS (
    SELECT DISTINCT ClientId
    FROM VisitPerTicket
),

ClientFirstVisit AS (
    SELECT
        ClientId,
        MIN(VisitDate) AS FirstVisitDate
    FROM (
        SELECT
            stl.ClientId,
            CAST(stl.TransactionDate AS DATE) AS VisitDate
        FROM scvSaleTransactionLine2 stl
        INNER JOIN scvTransactionType stt
            ON stt.TransactionType = stl.TransactionType
           AND stt.IsSale = 1
        WHERE stl.VoidStatusStringCode = 'VoidStatus.Normal'
          AND stl.ClientId NOT IN (1,2,8,9)
          AND ISNULL(stl.ItemType,0) NOT IN (7,10)
          AND ISNULL(stl.ItemSubTypeCode,0) <> 11
    ) h
    GROUP BY ClientId
)

SELECT
    CASE
        WHEN fv.FirstVisitDate < CAST(@From AS DATE) THEN 'Returning'
        ELSE 'New'
    END AS ClientType,
    COUNT(DISTINCT cr.ClientId) AS ClientCount
FROM ClientsInRange cr
JOIN ClientFirstVisit fv
    ON fv.ClientId = cr.ClientId
GROUP BY
    CASE
        WHEN fv.FirstVisitDate < CAST(@From AS DATE) THEN 'Returning'
        ELSE 'New'
    END;
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.error('New vs Returning Clients error:', err);
    res.status(500).json({ error: 'Failed to load new vs returning clients' });
  }
});


/* ---------------------------------------------------
   2️⃣ Client Retention Trend
--------------------------------------------------- */
router.get('/retention-trend', async (req, res) => {
  let from, to;

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to   = req.query.to;
  } else {
    const range = req.query.range || 'today';
    ({ from, to } = getDateRange(range));
  }

  const diffInDays = Math.ceil(
    (new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24)
  );

  let bucketType;
  let query;

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.timeout = 300000;
    request.input('From', sql.Date, from);
    request.input('To',   sql.Date, to);
    request.input('SiteId', sql.Int, 0);

    /* =====================================================
       BUCKET SELECTION
    ===================================================== */
    if (diffInDays <= 31) bucketType = 'day';
    else if (diffInDays <= 90) bucketType = 'week';
    else if (diffInDays <= 180) bucketType = '15-days';
    else bucketType = 'month';

    /* =====================================================
       POS-ACCURATE RETENTION TREND QUERY
    ===================================================== */
    query = `
    ;WITH
    -- =========================================
    -- Step 1: Valid sales (EXACT POS FILTERS)
    -- =========================================
    ValidSales AS (
      SELECT
        stl.ClientId,
        stl.TransactionNumber,
        CAST(stl.TransactionDate AS DATE) AS VisitDate
      FROM scvSaleTransactionLine2 stl
      INNER JOIN scvTransactionType stt
        ON stt.TransactionType = stl.TransactionType
       AND stt.IsSale = 1
      WHERE stl.SiteId = @SiteId
        AND stl.TransactionDate BETWEEN @From AND DATEADD(DAY,1,@To)
        AND stl.VoidStatusStringCode = 'VoidStatus.Normal'
        AND stl.ClientId NOT IN (1,2,8,9)
        AND ISNULL(stl.ItemType,0) NOT IN (7,10)
        AND ISNULL(stl.ItemSubTypeCode,0) <> 11
    ),

    -- =========================================
    -- Step 2: ONE VISIT = ONE TRANSACTION
    -- =========================================
    VisitPerTicket AS (
      SELECT
        ClientId,
        TransactionNumber,
        VisitDate
      FROM ValidSales
      GROUP BY ClientId, TransactionNumber, VisitDate
    ),

    -- =========================================
    -- Step 3: First visit (ALL TIME)
    -- =========================================
    ClientFirstVisit AS (
      SELECT
        h.ClientId,
        MIN(CAST(h.TransactionDate AS DATE)) AS FirstVisitDate
      FROM scvSaleTransactionLine2 h
      INNER JOIN scvTransactionType ht
        ON ht.TransactionType = h.TransactionType
       AND ht.IsSale = 1
      WHERE h.VoidStatusStringCode = 'VoidStatus.Normal'
        AND h.ClientId NOT IN (1,2,8,9)
        AND ISNULL(h.ItemType,0) NOT IN (7,10)
        AND ISNULL(h.ItemSubTypeCode,0) <> 11
      GROUP BY h.ClientId
    ),

    -- =========================================
    -- Step 4: Bucket assignment
    -- =========================================
    BucketedVisits AS (
      SELECT
        v.ClientId,
        v.VisitDate,
        f.FirstVisitDate,
        CASE
          WHEN '${bucketType}' = 'day'
            THEN v.VisitDate

          WHEN '${bucketType}' = 'week'
            THEN DATEADD(DAY,(DATEDIFF(DAY,@From,v.VisitDate)/7)*7,@From)

          WHEN '${bucketType}' = '15-days'
            THEN DATEADD(DAY,(DATEDIFF(DAY,@From,v.VisitDate)/15)*15,@From)

          ELSE DATEFROMPARTS(YEAR(v.VisitDate),MONTH(v.VisitDate),1)
        END AS BucketStart
      FROM VisitPerTicket v
      INNER JOIN ClientFirstVisit f ON f.ClientId = v.ClientId
    )

    -- =========================================
    -- Step 5: FINAL RETENTION TREND
    -- =========================================
    SELECT
      BucketStart,
      COUNT(*) AS TotalVisits,

      -- 🔥 POS-accurate returning visits
      SUM(
        CASE
          WHEN FirstVisitDate < @From
            OR (FirstVisitDate < VisitDate)
          THEN 1
          ELSE 0
        END
      ) AS ReturningVisits,

      SUM(
        CASE
          WHEN FirstVisitDate >= @From
          THEN 1
          ELSE 0
        END
      ) AS NewVisits
    FROM BucketedVisits
    GROUP BY BucketStart
    ORDER BY BucketStart;
    `;

    const result = await request.query(query);

    res.json({
      bucket: bucketType,
      data: result.recordset || []
    });

  } catch (err) {
    console.error('Client Retention Trend error:', err);
    res.status(500).json({ error: 'Failed to load client retention trend' });
  }
});

/* ---------------------------------------------------
   3️⃣ Top Spending Clients
--------------------------------------------------- */
router.get('/top-spenders', async (req, res) => {
  let from, to;
  const limit = parseInt(req.query.limit || 10, 10);

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to = req.query.to;
  } else {
    const range = req.query.range || 'today';
    ({ from, to } = getDateRange(range));
  }

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.timeout = 300000;
    request.input('From', sql.VarChar, from);
    request.input('To', sql.VarChar, to);
    request.input('Limit', sql.Int, limit);
    request.input('SiteId', sql.Int, 0);

    const result = await request.query(`
      ;WITH ClientSales AS (
    SELECT
        stl.ClientId,
        SUM(CASE WHEN stt.IsSale = 0 THEN 0 ELSE stl.LineIncTaxAmount END) AS TotalSpend,
        COUNT(DISTINCT stl.TransactionNumber) AS TicketCount  -- Number of tickets
    FROM dbo.scvSaleTransactionLine2 stl
    INNER JOIN dbo.scvTransactionType stt
        ON stt.TransactionType = stl.TransactionType
    INNER JOIN dbo.clients c
        ON c.IdNumber = stl.ClientId
    WHERE stl.SiteId = @SiteId
      AND stl.TransactionDate >= @From
      AND stl.TransactionDate <= @To
      AND stl.VoidStatusStringCode = 'VoidStatus.Normal'
      AND stl.ClientId NOT IN (1,2,8,9)
      AND ISNULL(stl.ItemType,0) IN (1,2,3)          -- Services, Products, Sundry
      AND ISNULL(stl.ItemSubTypeCode,0) <> 11
    GROUP BY stl.ClientId
)
SELECT TOP (@Limit)
    c.FirstName + ' ' + c.LastName AS ClientName,
    c.Mobile AS PhoneNumber,          -- Added Mobile column
    cs.TicketCount AS Tickets,        -- renamed from Visits
    cs.TotalSpend
FROM ClientSales cs
INNER JOIN dbo.clients c
    ON c.IdNumber = cs.ClientId
ORDER BY cs.TotalSpend DESC;

    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.error('Top Spending Clients error:', err);
    res.status(500).json({ error: 'Failed to load top spending clients' });
  }
});


module.exports = router;
