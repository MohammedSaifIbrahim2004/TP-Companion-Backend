function buildDateFilter({ dateColumn, from, to }) {
  let where = '1=1';

  if (from) {
    where += ` AND ${dateColumn} >= @from`;
  }

  if (to) {
    where += ` AND ${dateColumn} < DATEADD(DAY, 1, @to)`;
  }

  return where;
}
function buildDateFilterDateOnly({ dateColumn, from }) {
  let where = '1=1';
  if (from) where += ` AND ${dateColumn} = @from`;
  return where;
}

module.exports = { buildDateFilter , buildDateFilterDateOnly };
