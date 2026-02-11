const express = require('express');
const router = express.Router();
const { poolPromise } = require('../db/sql');

router.get('/products', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);

  try {
    const pool = await poolPromise;


    // Use parameters to prevent SQL injection
    const result = await pool.request()
      .input('search', `%${query}%`)
      .query(`
        SELECT 
          c.IdNumber AS CompanyId,
          c.Name AS Company,
          l.IdNumber AS LineId,
          l.Name AS Line,
          p.Name,
          p.BuyPrice,
          p.SellPrice,
          b.Barcode,
          s.Name AS Supplier,
          p.IdNumber
        FROM products p
        LEFT JOIN barcode b ON p.IdNumber = b.ID
        LEFT JOIN Suppliers s ON p.DefaultSupplierId = s.Id
        LEFT JOIN lines l ON p.LineId = l.IdNumber
        LEFT JOIN companys c ON p.CompanyId = c.IdNumber
        WHERE p.Name LIKE @search OR l.Name LIKE @search OR c.Name LIKE @search
        ORDER BY Company, Line, p.Name
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
