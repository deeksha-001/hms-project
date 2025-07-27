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

db.connect(err => {
  if (err) {
    console.error('❌ MySQL connection failed:', err);
    return;
  }
  console.log('✅ Connected to MySQL');
});

// ===== MIDDLEWARE =====
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
     }
}));

// ===== STATIC FILES =====
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/doctor', express.static(path.join(__dirname, 'public doctor')));
app.use('/vaccine', express.static(path.join(__dirname, 'public vaccine')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ===== ROUTES =====
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/doctor', (_, res) => res.sendFile(path.join(__dirname, 'public doctor', 'index1.html')));
app.get('/vaccine', (_, res) => res.sendFile(path.join(__dirname, 'public vaccine', 'index.html')));
app.get('/admin/dashboard', (req, res) => {
  if (req.session.role === 'admin') {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'admin.html'));
  } else {
    res.status(403).send('Unauthorized access');

  }
});
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.log('Logout error:', err);
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

// ===== HELPER FUNCTION =====
function insertPatientRecord(userId, data, callback) {
  const query = `INSERT INTO patients (userId, name, age, phone, type, date, time, doctorId, doctorName, history, vaccines)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const values = [
    userId || null, data.name, data.age, data.phone, data.type,
    data.date, data.time, data.doctorId || null, data.doctorName || null,
    data.history || null, data.vaccines || null
  ];
  db.query(query, values, callback);
}

// ===== LOGIN (DRY admin/user logic) =====
app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;

  // 🔐 Check if admin
  if (phone === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    req.session.loggedIn = true;
    req.session.role = 'admin';
    return res.json({ success: true, role: 'admin', message: 'Admin login successful' });
  }

  // 👤 Else, check for regular user in DB
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
    req.session.role = user.role || 'user';
    req.session.loggedIn = true;

    res.json({ success: true, role: req.session.role });
  });
});

// ===== DOCTOR MODULE =====
app.get('/api/doctors', (_, res) => {
  db.query('SELECT * FROM doctors', (err, results) => {
    if (err) return res.status(500).json({ error: 'Failed to load doctors' });
    res.json(results);
  });
});

app.post('/api/book', (req, res) => {
  const { doctorId, doctorName, date, time, name, age, phone, history } = req.body;
  const userId = req.session.userId || null;

  if (!doctorId || !doctorName || !date || !time || !name || !age || !phone)
    return res.status(400).json({ error: 'Missing fields' });

  db.query(
    `SELECT COUNT(*) AS count FROM doctor_appointments WHERE doctorId = ? AND date = ? AND time = ?`,
    [doctorId, date, time],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Error checking slot' });
      if (results[0].count >= 8) return res.status(409).json({ error: 'Slot full' });

      db.query(
        `SELECT * FROM patients WHERE 
         (userId = ? OR (name = ? AND phone = ?)) AND 
         type = 'doctor' AND doctorId = ? AND date = ? AND time = ?`,
        [userId, name, phone, doctorId, date, time],
        (err2, dup) => {
          if (err2) return res.status(500).json({ error: 'Duplicate check failed' });
          if (dup.length > 0) return res.status(409).json({ error: 'Already booked' });

          db.query(
            `INSERT INTO doctor_appointments (doctorId, doctorName, name, age, phone, history, date, time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [doctorId, doctorName, name, age, phone, history, date, time],
            (err3) => {
              if (err3) return res.status(500).json({ error: 'Booking failed' });
              insertPatientRecord(userId, {
                name, age, phone, type: 'doctor',
                date, time, doctorId, doctorName, history
              }, (err4) => {
                if (err4) return res.status(500).json({ error: 'Patient save failed' });
                res.json({ message: '✅ Doctor appointment booked' });
              });
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
  const userId = req.session.userId || null;

  if (!name || !age || !phone || !ageGroup || !appointmentDate || !appointmentTime || !vaccines)
    return res.status(400).json({ error: 'Missing fields' });

  const vaccineList = Array.isArray(vaccines) ? vaccines.join(', ') : vaccines;

  db.query(
    `SELECT COUNT(*) AS count FROM vaccine_appointments WHERE date = ? AND time = ? AND ageGroup = ?`,
    [appointmentDate, appointmentTime, ageGroup],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Slot check error' });
      if (results[0].count >= 6) return res.status(409).json({ error: 'Slot full' });

      db.query(
        `SELECT * FROM patients WHERE 
         (userId = ? OR (name = ? AND phone = ?)) AND 
         type = 'vaccine' AND date = ? AND time = ?`,
        [userId, name, phone, appointmentDate, appointmentTime],
        (err2, dup) => {
          if (err2) return res.status(500).json({ error: 'Duplicate check failed' });
          if (dup.length > 0) return res.status(409).json({ error: 'Already booked' });

          db.query(
            `INSERT INTO vaccine_appointments (name, age, phone, ageGroup, date, time, vaccines)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, age, phone, ageGroup, appointmentDate, appointmentTime, vaccineList],
            (err3) => {
              if (err3) return res.status(500).json({ error: 'Booking failed' });
              insertPatientRecord(userId, {
                name, age, phone, type: 'vaccine',
                date: appointmentDate, time: appointmentTime, vaccines: vaccineList
              }, (err4) => {
                if (err4) return res.status(500).json({ error: 'Patient save failed' });
                res.json({ message: '✅ Vaccine appointment booked' });
              });
            }
          );
        }
      );
    }
  );
});

// ===== ADMIN: View All =====
app.get('/api/doctorAppointments', (_, res) => {
  db.query('SELECT * FROM doctor_appointments', (err, results) => {
    if (err) return res.status(500).json({ error: 'Load failed' });
    res.json(results);
  });
});
app.get('/api/vaccineAppointments', (_, res) => {
  db.query('SELECT * FROM vaccine_appointments', (err, results) => {
    if (err) return res.status(500).json({ error: 'Load failed' });
    res.json(results);
  });
});

// ===== USER AUTH =====
app.post('/api/register', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ message: 'All fields required' });

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.query('INSERT INTO users (phone, password) VALUES (?, ?)', [phone, hashed], (err) => {
      if (err) return res.status(500).json({ message: 'Already registered' });
      res.json({ message: '✅ Registered successfully' });
    });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/userlogout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/api/user/bookings', (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  db.query(
    'SELECT id, type, date, time, doctorName, vaccines, notes FROM patients WHERE userId = ?',
    [userId],
    (err, results) => {
      if (err) return res.status(500).json({ error: 'Fetch failed' });
      res.json(results);
    }
  );
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
      if (err) return res.status(500).json({ message: 'Update failed' });
      res.json({ message: 'Notes saved' });
    }
  );
});

app.get('/api/check-session', (req, res) => {
  if (req.session.role === 'admin') return res.json({ loggedIn: true, role: 'admin' });
  if (req.session.role === 'user') return res.json({ loggedIn: true, role: 'user' });
  res.json({ loggedIn: false });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});