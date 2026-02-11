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
   1️⃣ Revenue Trend (Day / Week / Month / Year)
--------------------------------------------------- */
router.get('/trend', async (req, res) => {
  let from, to;

  if (req.query.from && req.query.to) {
    from = req.query.from;
    to = req.query.to;
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
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    // -----------------------------
    //  Day bucket (diffInDays <= 31)
    // -----------------------------
    if (diffInDays <= 31) {
      bucketType = 'day';
      query = `
        WITH DailyBuckets AS (
          SELECT
            CONVERT(date, h.Date) AS BucketStart,
            CASE 
              WHEN ISNULL(h.TransactionType, 1) = 3 THEN -ABS(h.Amount)  -- refunds
              WHEN ISNULL(h.TransactionType, 1) = 1 AND h.ItemType <> 4 THEN h.Amount  -- normal sales
              ELSE 0
            END AS AmountAdjusted
          FROM dbo.historys h
          WHERE h.Date >= @from
            AND h.Date < DATEADD(DAY, 1, @to)
        )
        SELECT
          FORMAT(BucketStart, 'yyyy-MM-dd') AS DateLabel,
          BucketStart,
          SUM(AmountAdjusted) AS Revenue
        FROM DailyBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;

    // -----------------------------
    //  Week bucket (diffInDays <= 90)
    // -----------------------------
    } else if (diffInDays <= 90) {
      bucketType = 'week';
      query = `
        WITH WeeklyBuckets AS (
          SELECT
            DATEADD(DAY, (DATEDIFF(DAY, @from, h.Date)/7)*7, @from) AS BucketStart,
            CASE 
              WHEN ISNULL(h.TransactionType, 1) = 3 THEN -ABS(h.Amount)
              WHEN ISNULL(h.TransactionType, 1) = 1 AND h.ItemType <> 4 THEN h.Amount
              ELSE 0
            END AS AmountAdjusted
          FROM dbo.historys h
          WHERE h.Date >= @from
            AND h.Date < DATEADD(DAY, 1, @to)
        )
        SELECT
          CONCAT(
            FORMAT(BucketStart, 'dd MMM'),
            ' – ',
            FORMAT(DATEADD(DAY, 6, BucketStart), 'dd MMM')
          ) AS DateLabel,
          BucketStart,
          SUM(AmountAdjusted) AS Revenue
        FROM WeeklyBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;

    // -----------------------------
    //  15-days bucket (diffInDays <= 180)
    // -----------------------------
    } else if (diffInDays <= 180) {
      bucketType = '15-days';
      query = `
        WITH FifteenDayBuckets AS (
          SELECT
            DATEADD(DAY, (DATEDIFF(DAY, @from, h.Date)/15)*15, @from) AS BucketStart,
            CASE 
              WHEN ISNULL(h.TransactionType, 1) = 3 THEN -ABS(h.Amount)
              WHEN ISNULL(h.TransactionType, 1) = 1 AND h.ItemType <> 4 THEN h.Amount
              ELSE 0
            END AS AmountAdjusted
          FROM dbo.historys h
          WHERE h.Date >= @from
            AND h.Date < DATEADD(DAY, 1, @to)
        )
        SELECT
          CONCAT(
            FORMAT(BucketStart, 'dd MMM'),
            ' – ',
            FORMAT(DATEADD(DAY, 14, BucketStart), 'dd MMM')
          ) AS DateLabel,
          BucketStart,
          SUM(AmountAdjusted) AS Revenue
        FROM FifteenDayBuckets
        GROUP BY BucketStart
        ORDER BY BucketStart;
      `;

    // -----------------------------
    //  Month bucket (diffInDays > 180)
    // -----------------------------
    } else {
      bucketType = 'month';
      query = `
        WITH MonthlyBuckets AS (
          SELECT
            DATEFROMPARTS(YEAR(h.Date), MONTH(h.Date), 1) AS BucketStart,
            CASE 
              WHEN ISNULL(h.TransactionType, 1) = 3 THEN -ABS(h.Amount)
              WHEN ISNULL(h.TransactionType, 1) = 1 AND h.ItemType <> 4 THEN h.Amount
              ELSE 0
            END AS AmountAdjusted
          FROM dbo.historys h
          WHERE h.Date >= @from
            AND h.Date < DATEADD(DAY, 1, @to)
        )
        SELECT
          FORMAT(BucketStart, 'MMM yyyy') AS DateLabel,
          BucketStart,
          SUM(AmountAdjusted) AS Revenue
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
    console.error('Revenue trend error:', err);
    res.status(500).json({ error: 'Failed to load revenue trend' });
  }
});



/* ---------------------------------------------------
   2️⃣ Revenue by Category (Same ranges)
--------------------------------------------------- */
router.get('/by-category', async (req, res) => {
  let from, to;

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
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    const result = await request.query(`
      SELECT
          c.Name AS CategoryName,
          SUM(h.Amount) AS TotalAmount
      FROM dbo.historys AS h
      INNER JOIN dbo.services AS s
          ON h.Service = s.IdNumber
      INNER JOIN dbo.category AS c
          ON s.Category = c.[Id Number]
      WHERE h.Date >= @from
        AND h.Date <  @to
      GROUP BY c.Name
      ORDER BY TotalAmount DESC;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Revenue by category error:', err);
    res.status(500).json({ error: 'Failed to load revenue by category' });
  }
});


/* ---------------------------------------------------
   3️⃣ Payment Method Split (Same ranges)
--------------------------------------------------- */
router.get('/payment-split', async (req, res) => {
  let from, to;

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
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    const result = await request.query(`
      SELECT 
    CASE WHEN p.PaymentTypeId = 5 THEN 'Gift Card' ELSE p.PaymentTypeName END AS PaymentMethod,
    SUM(p.PaymentAmount) AS Revenue
FROM dbo.scvSaleTransactionPayment AS p
WHERE 
    p.VoidStatusCode = 0
    AND p.TransactionDate >= @from
    AND p.TransactionDate < DATEADD(DAY, 1, @to)
GROUP BY 
    CASE WHEN p.PaymentTypeId = 5 THEN 'Gift Card' ELSE p.PaymentTypeName END
ORDER BY Revenue DESC;

    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Payment split error:', err);
    res.status(500).json({ error: 'Failed to load payment split' });
  }
});

module.exports = router;
