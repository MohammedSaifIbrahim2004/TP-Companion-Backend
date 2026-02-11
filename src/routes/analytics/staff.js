const express = require('express');
const router = express.Router();

const { sql, poolPromise } = require('../../db/sql');

// Default today
const today = () => new Date().toISOString().split('T')[0];

/* ---------------------------------------------------
   🧑‍💼 1️⃣ Revenue by Staff
--------------------------------------------------- */
router.get('/revenue', async (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || today();

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.input('from', sql.Date, from);
    request.input('to', sql.Date, to);

    const result = await request.query(`
      SELECT TOP (100) PERCENT
    e.IdNumber AS StaffId,
    { fn CONCAT(e.FirstName, ' ' + e.LastName) } AS StaffName,
    SUM(h.Amount) AS Revenue
FROM dbo.historys AS h
INNER JOIN dbo.employs AS e
    ON h.StylistIdNumber = e.IdNumber
WHERE
    h.ItemType IN (1, 2, 3)
    AND ISNULL(h.TransactionType, 1) = 1
    AND h.Date >= @from
    AND h.Date < DATEADD(DAY, 1, @to)  -- make @to inclusive
GROUP BY
    e.IdNumber,
    e.FirstName,
    e.LastName
ORDER BY
    Revenue DESC;

    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Staff revenue error:', err);
    res.status(500).json({ error: 'Failed to load staff revenue' });
  }
});

/* ---------------------------------------------------
   ⏱️ 2️⃣ Staff Utilization (Accurate)
--------------------------------------------------- */
router.get('/utilization', async (req, res) => {
  const from = req.query.from || today();
  const to = req.query.to || today();

  try {
    const pool = await poolPromise;


    const request = pool.request();
    request.input('FromDate', sql.Date, from);
    request.input('ToDate', sql.Date, to);

    const result = await request.query(`
          ;WITH TimeData AS
    (
        -- ===============================
        -- A️⃣ Appointment Time (Worked)
        -- ===============================
        SELECT
            'A' AS Type,
            A.[Date],
            A.Duration AS Minutes,
            E.IdNumber AS EmployeeID,
            E.FirstName,
            E.LastName
        FROM dbo.Appoints A
        INNER JOIN dbo.Employs E
            ON A.Employee = E.IdNumber
        WHERE
            A.[Date] BETWEEN @FromDate AND @ToDate

        UNION ALL

        -- ===============================
        -- R️⃣ Roster Time (Available)
        -- ===============================
        SELECT
            'R' AS Type,
            R.[Date],
            CASE
                WHEN R.[Actual Start] > 0 THEN
                    ABS(
                        ([Actual Finish] / 100 * 60 + [Actual Finish] % 100) -
                        ([Actual Start]  / 100 * 60 + [Actual Start]  % 100)
                    )
                ELSE
                    ABS(
                        ([Rostered Finish] / 100 * 60 + [Rostered Finish] % 100) -
                        ([Rostered Start]  / 100 * 60 + [Rostered Start]  % 100)
                    )
                    -
                    ABS(
                        ([Break Finish] / 100 * 60 + [Break Finish] % 100) -
                        ([Break Start]  / 100 * 60 + [Break Start]  % 100)
                    )
            END AS Minutes,
            E.IdNumber AS EmployeeID,
            E.FirstName,
            E.LastName
        FROM dbo.Roster R
        INNER JOIN dbo.Employs E
            ON R.Stylist = E.IdNumber
        WHERE
            R.[Date] BETWEEN @FromDate AND @ToDate
            AND (R.RosterTypeId = 0 OR R.RosterTypeId IS NULL)
    )

    -- ===============================
    -- 🔢 Final Utilization (Top 10)
    -- ===============================
    SELECT TOP (10)
        EmployeeID AS StaffId,
        CONCAT(FirstName, ' ', LastName) AS StaffName,

        -- ⏱️ Hours
        SUM(CASE WHEN Type = 'A' THEN Minutes ELSE 0 END) / 60.0 AS BookedHours,
        SUM(CASE WHEN Type = 'R' THEN Minutes ELSE 0 END) / 60.0 AS AvailableHours,

        -- 📊 Utilization
        CASE
            -- No roster but worked → 100%
            WHEN
                SUM(CASE WHEN Type = 'R' THEN Minutes ELSE 0 END) = 0
                AND SUM(CASE WHEN Type = 'A' THEN Minutes ELSE 0 END) > 0
            THEN 100.0

            -- Normal calculation
            WHEN
                SUM(CASE WHEN Type = 'R' THEN Minutes ELSE 0 END) > 0
            THEN
                SUM(CASE WHEN Type = 'A' THEN Minutes ELSE 0 END) * 100.0 /
                SUM(CASE WHEN Type = 'R' THEN Minutes ELSE 0 END)

            -- No work, no roster
            ELSE 0
        END AS UtilizationPercent
    FROM TimeData
    GROUP BY EmployeeID, FirstName, LastName
    ORDER BY UtilizationPercent DESC;

    `);

    res.json(result.recordset);
  } catch (err) {
    console.error('Staff utilization error:', err);
    res.status(500).json({ error: 'Failed to load staff utilization' });
  }
});


module.exports = router;
