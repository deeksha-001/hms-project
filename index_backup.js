const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Initialize the app
const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Path to the appointments file
const filePath = path.join(__dirname, "appointments.json");

// Read appointments from the file and store in memory
let appointments = [];

// Load existing appointments from file at startup
fs.readFile(filePath, "utf8", (err, data) => {
  if (err) {
    console.error("Error reading file:", err);
    appointments = [];
  } else {
    try {
      appointments = JSON.parse(data);
      if (!Array.isArray(appointments)) {
        appointments = [];
      }
    } catch (e) {
      console.error("Error parsing JSON:", e);
      appointments = [];
    }
  }
});

// Test route to verify server is running
app.get("/", (req, res) => {
  res.send("Vaccine Backend Server is Running!");
});

// POST route to schedule an appointment
app.post("/schedule", (req, res) => {
  const { ageGroup, appointmentDate, appointmentTime, vaccines } = req.body;

  // Validation - Ensure all fields are provided
  if (!ageGroup || !appointmentDate || !appointmentTime || !vaccines || vaccines.length === 0) {
    return res.status(400).json({ message: "All fields are required!" });
  }

  // Extract the hour (e.g., "9" from "9:00 AM")
  const appointmentHour = parseInt(appointmentTime.split(":")[0]);

  // Check if the same age group already has an appointment in this hour
  const isDuplicate = appointments.some(
    (appointment) =>
      appointment.appointmentDate === appointmentDate &&
      parseInt(appointment.appointmentTime.split(":")[0]) === appointmentHour &&
      appointment.ageGroup === ageGroup
  );

  if (isDuplicate) {
    return res.status(400).json({
      message: `Only one appointment per age group is allowed per hour!`,
    });
  }

  // Create the appointment object
  const appointment = {
    ageGroup,
    appointmentDate,
    appointmentTime,
    vaccines,
  };

  // Add the new appointment to the array
  appointments.push(appointment);

  // Write to file
  fs.writeFile(filePath, JSON.stringify(appointments, null, 2), (err) => {
    if (err) {
      console.error("Error writing file:", err);
      return res.status(500).json({ message: "Server error" });
    }

    res.json({
      message: "Appointment scheduled successfully",
      appointmentDetails: appointment,
    });
  });
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
