const express = require('express');
const router = express.Router();
const { sql, poolPromise } = require('../db/sql'); // include sql

// GET all products
router.get('/', async (req, res) => {
  try {

    const pool = await poolPromise; // wait for pool to connect

    const result = await pool.request().query(`
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
      WHERE ISNULL(p.Active, 0) = 1
      ORDER BY Company, Line, p.Name;
    `);

    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /move - move a product to a new company/line
router.post('/move', async (req, res) => {
  const { productId, newCompanyId, newLineId } = req.body;

  if (!productId || !newCompanyId || !newLineId) {
    return res.status(400).json({ error: "productId, newCompanyId, and newLineId are required" });
  }

  try {
    const pool = await poolPromise;


    await pool.request()
      .input('productId', sql.Int, productId)
      .input('newCompanyId', sql.Int, newCompanyId)
      .input('newLineId', sql.Int, newLineId)
      .query(`
        UPDATE products
        SET CompanyId = @newCompanyId,
            LineId = @newLineId
        WHERE IdNumber = @productId
      `);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
