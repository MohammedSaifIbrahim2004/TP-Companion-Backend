const WinReg = require('winreg');

const REG_KEY = new WinReg({
  hive: WinReg.HKLM,
  key: '\\SOFTWARE\\WOW6432Node\\ShortCuts\\Database\\ShortcutsPOS'
});

function readSqlInstance() {
  return new Promise((resolve, reject) => {
    REG_KEY.values((err, items) => {
      if (err) return reject(err);

      if (!items || items.length === 0) {
        return reject(new Error('No registry values found'));
      }

      // Expected value format:
      // (local)\ShortcutsPOS
      // SERVERNAME\ShortcutsPOS
      const instance = items[0].value;
      resolve(instance);
    });
  });
}

module.exports = {
  readSqlInstance
};
