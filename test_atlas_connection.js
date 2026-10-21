const mongoose = require('mongoose');
const dotenv = require('dotenv');
const dns = require('dns');

const env = dotenv.config().parsed || {};
const uri = (process.env.MONGODB_URI || env.MONGODB_URI || env['mongodb.uri'] || '').trim();

console.log('Testing MongoDB Atlas connection...');
console.log('Target URI:', uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@'));

if (!uri) {
  console.error('Error: No MongoDB URI found in .env');
  process.exit(1);
}

if (uri.includes('<db_password>')) {
  console.error('\n⚠️ NOTICE: The URI still contains the literal placeholder "<db_password>".');
  console.error('Please replace <db_password> with your actual MongoDB Atlas database user password in .env.');
  process.exit(2);
}

mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 })
  .then(() => {
    console.log('\n✅ Successfully connected to MongoDB Atlas!');
    console.log('Database:', mongoose.connection.name);
    console.log('Host:', mongoose.connection.host);
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Connection failed:');
    console.error(err.message);
    if (err.message.includes('SSL alert') || err.message.includes('IP that isn\'t whitelisted')) {
      console.error('\n👉 Network Access Check:');
      console.error('In MongoDB Atlas -> Network Access -> Add IP Address:');
      console.error('Add 0.0.0.0/0 (Allow Access from Anywhere) or your IP (122.161.50.185).');
    } else if (err.message.includes('bad auth') || err.message.includes('Authentication failed')) {
      console.error('\n👉 Authentication Check:');
      console.error('Your username or password is incorrect in .env.');
    }
    process.exit(1);
  });
