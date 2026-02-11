const express = require('express');
const router = express.Router();

const { sql, poolPromise } = require('../../db/sql');

const today = () => new Date().toISOString().split('T')[0];

/* ---------------------------------------------------
   📦 1️⃣ Low Stock Alerts
--------------------------------------------------- */
router.get('/low-stock', async (req, res) => {
  try {
    const pool = await poolPromise;


    const result = await pool.request().query(`
      SELECT TOP (100) PERCENT
          p.IdNumber AS ProductId,
          p.Name AS ProductName,

          c.IdNumber AS CompanyId,
          ISNULL(c.Name, 'Uncategorized') AS Company,

          l.IdNumber AS LineId,
          ISNULL(l.Name, 'Uncategorized') AS Line,

          s.Name AS Supplier,
          b.Barcode,

          p.[Current] AS QuantityLeft,
          p.WarningLevelQuantity
      FROM dbo.products p
      LEFT JOIN dbo.barcode b
          ON p.IdNumber = b.ID
      LEFT JOIN dbo.Suppliers s
          ON p.DefaultSupplierId = s.Id
      LEFT JOIN dbo.lines l
          ON p.LineId = l.IdNumber
      LEFT JOIN dbo.companys c
          ON p.CompanyId = c.IdNumber
      WHERE
          ISNULL(p.Active, 0) = 1
          AND p.WarningLevelQuantity IS NOT NULL
          AND p.[Current] < p.WarningLevelQuantity
      ORDER BY
          c.Name,
          l.Name,
          p.[Current] ASC
    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.error('Low stock error:', err);
    res.status(500).json({ error: 'Failed to load low stock products' });
  }
});


/* ---------------------------------------------------
   📊 2️⃣ Product Sales by Category / Line
--------------------------------------------------- */
router.get('/sales', async (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || today();

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    const result = await request.query(`
      SELECT
    ISNULL(c.Name, 'Uncategorized') AS Company,
    SUM(stl.ItemQuantity) AS UnitsSold,
    SUM(stl.LineIncTaxAmount) AS Revenue
FROM dbo.scvSaleTransactionLine2 stl
INNER JOIN dbo.products p
    ON stl.ItemId = p.IdNumber
LEFT JOIN dbo.companys c        -- assuming the table is companies
    ON p.CompanyId = c.IdNumber
INNER JOIN dbo.scvTransactionType stt
    ON stt.TransactionType = stl.TransactionType
WHERE
    stl.ItemType = 2                   -- Products only
    AND stt.IsSale = 1                  -- Only valid sales
    AND stl.VoidStatusStringCode = 'VoidStatus.Normal'
    AND stl.TransactionDate >= @from
    AND stl.TransactionDate < DATEADD(DAY, 1, @to)
GROUP BY c.Name
ORDER BY Revenue DESC;

    `);

    res.json(result.recordset || []);
  } catch (err) {
    console.error('Product sales error:', err);
    res.status(500).json({ error: 'Failed to load product sales' });
  }
});

module.exports = router;
