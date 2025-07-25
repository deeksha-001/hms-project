require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const PORT = 3000;

// ===== DATABASE CONNECTION =====
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT   
});

module.exports = db;

db.connect(err => {
  if (err) {
    console.error('❌ MySQL connection failed:', err);
    return;
  }
  console.log('✅ Connected to MySQL');
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// ===== STATIC FILE SERVING =====
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/doctor', express.static(path.join(__dirname, 'public doctor')));
app.use('/vaccine', express.static(path.join(__dirname, 'public vaccine')));
// ✅ FIXED /admin route — correct role check & only defined once!
app.get('/admin/dashboard', (req, res) => {
  if (req.session.role === 'admin') {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
  } else {
    res.redirect('/admin/login');
  }
});

app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ===== ROUTES =====
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/doctor', (_, res) => res.sendFile(path.join(__dirname, 'public doctor', 'index1.html')));
app.get('/vaccine', (_, res) => res.sendFile(path.join(__dirname, 'public vaccine', 'index.html')));
app.get('/admin/login', (req, res) => {
  if (req.session.role === 'admin') {
    return res.redirect('/admin/dashboard');
  }
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
});



app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.log('Logout error:', err);
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});


// ===== ADMIN LOGIN =====
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'password123';

app.post('/api/login', (req, res) => {
  const { phone, password } = req.body;

  // Admin login
  if (phone === 'admin' && password === 'password123') {
    req.session.loggedIn = true;
    req.session.role = 'admin';  // ✅ Important for check-session
    return res.json({ success: true, role: 'admin' });
  }

  // Patient login
  db.query('SELECT * FROM users WHERE phone = ?', [phone], async (err, results) => {
    if (err || results.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid phone or password' });
    }

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.role = 'user';  // ✅ Important for check-session
    req.session.loggedIn = true;

    res.json({ success: true, role: 'user' });
  });
});




// ===== DOCTOR MODULE =====
app.get('/api/doctors', (_, res) => {
  db.query('SELECT * FROM doctors', (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to load doctors' });
    res.json(results);
  });
});

app.get('/api/checkSlot', (req, res) => {
  const { doctorId, date, time } = req.query;
  if (!doctorId || !date || !time) return res.status(400).json({ error: 'Missing parameters' });

  db.query(
    `SELECT COUNT(*) AS count FROM doctor_appointments WHERE doctorId = ? AND date = ? AND time = ?`,
    [doctorId, date, time],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Server error while checking slot' });
      res.json({ full: results[0].count >= 6, count: results[0].count });
    }
  );
});

app.post('/api/book', (req, res) => {
  const { doctorId, doctorName, date, time, name, age, phone, history } = req.body;
  if (!doctorId || !doctorName || !date || !time || !name)
    return res.status(400).json({ error: 'Missing required fields' });

  db.query(
    `SELECT COUNT(*) AS count FROM doctor_appointments WHERE doctorId = ? AND date = ? AND time = ?`,
    [doctorId, date, time],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error checking slot' });

      if (results[0].count >= 6) return res.json({ error: 'Slot fully booked' });

      db.query(
        `INSERT INTO doctor_appointments (doctorId, doctorName, name, age, phone, history, date, time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [doctorId, doctorName, name, age, phone, history, date, time],
        (err2) => {
          if (err2) return res.status(500).json({ error: 'Failed to book appointment' });

          db.query(
            `INSERT INTO patients (userId, name, age, phone, type, date, time, doctorId, doctorName, history)
             VALUES (?, ?, ?, ?, 'doctor', ?, ?, ?, ?, ?)`,
            [req.session.userId || null, name, age, phone, date, time, doctorId, doctorName, history],
            (err3) => {
              if (err3) return res.status(500).json({ error: 'Failed to save patient record' });
              res.json({ message: '✅ Doctor appointment booked successfully!' });
            }
          );
        }
      );
    }
  );
});

// ===== VACCINE MODULE =====
app.post('/schedule', (req, res) => {
  const { name, age, phone, ageGroup, appointmentDate, appointmentTime, vaccines } = req.body;
  if (!name || !age || !phone || !ageGroup || !appointmentDate || !appointmentTime || !vaccines)
    return res.status(400).json({ error: 'Missing fields' });

  const vaccineList = Array.isArray(vaccines) ? vaccines.join(', ') : vaccines;

  db.query(
    `SELECT COUNT(*) AS count FROM vaccine_appointments WHERE date = ? AND time = ? AND ageGroup = ?`,
    [appointmentDate, appointmentTime, ageGroup],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error checking booking limit' });

      if (results[0].count >= 5)
        return res.status(409).json({ error: '❌ Slot already fully booked for this age group!' });

      db.query(
        `INSERT INTO vaccine_appointments (name, age, phone, ageGroup, date, time, vaccines)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, age, phone, ageGroup, appointmentDate, appointmentTime, vaccineList],
        (err2) => {
          if (err2) return res.status(500).json({ error: 'Failed to save vaccine appointment' });

          db.query(
            `INSERT INTO patients (userId, name, age, phone, type, date, time, vaccines)
             VALUES (?, ?, ?, ?, 'vaccine', ?, ?, ?)`,
            [req.session.userId || null, name, age, phone, appointmentDate, appointmentTime, vaccineList],
            (err3) => {
              if (err3) return res.status(500).json({ error: 'Failed to save patient record' });
              res.json({ message: '✅ Vaccine appointment scheduled successfully!' });
            }
          );
        }
      );
    }
  );
});

// Admin: View all appointments
app.get('/api/doctorAppointments', (req, res) => {
  db.query('SELECT * FROM doctor_appointments', (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to load doctor appointments' });
    res.json(results);
  });
});

app.get('/api/vaccineAppointments', (req, res) => {
  db.query('SELECT * FROM vaccine_appointments', (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to load vaccine appointments' });
    res.json(results);
  });
});

// ===== USER AUTH MODULE =====
app.post('/api/register', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ message: "All fields required" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.query('INSERT INTO users (phone, password) VALUES (?, ?)', [phone, hashed], (err) => {
      if (err) return res.status(500).json({ message: 'Phone number already registered' });
      res.json({ message: '✅ Registered successfully' });
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/userlogin', (req, res) => {
  const { phone, password } = req.body;

  // Admin shortcut login
  if (phone === 'admin' && password === 'admin123') {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    return res.json({ message: 'Admin login success', role: 'admin' });
  }

  // Patient login
  db.query('SELECT * FROM users WHERE phone = ?', [phone], async (err, results) => {
    if (err || results.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

    const user = results[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Wrong password' });

    req.session.userId = user.id;
    req.session.role = 'user';
    req.session.loggedIn = true;
    res.json({ message: 'User login success', role: 'user' });
  });
});


app.get('/api/userlogout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out successfully' }));
});

app.get('/api/user/bookings', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  db.query('SELECT id, type, date, time, doctorName, vaccines, notes FROM patients WHERE userId = ?', [userId], (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch bookings' });
    res.json(results);
  });
});

app.post('/api/user/bookings/:id/notes', (req, res) => {
  const userId = req.session.userId;
  const bookingId = req.params.id;
  const { notes } = req.body;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  db.query(
    'UPDATE patients SET notes = ? WHERE id = ? AND userId = ?',
    [notes, bookingId, userId],
    (err) => {
      if (err) return res.status(500).json({ message: 'Failed to update notes' });
      res.json({ message: 'Notes saved' });
    }
  );
});

app.get('/api/check-session', (req, res) => {
  if (req.session.role === 'admin') {
    return res.json({ loggedIn: true, role: 'admin' });
  }
  if (req.session.role === 'user') {
    return res.json({ loggedIn: true, role: 'user' });
  }
  return res.json({ loggedIn: false });
});



// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
