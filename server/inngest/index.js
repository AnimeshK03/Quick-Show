import { Inngest } from "inngest";
import User from "../models/User.model.js";
import Booking from "../models/Booking.model.js";
import Show from "../models/Show.model.js";
import sendEmail from "../configs/nodeMailer.js";

// Create a client to send and receive events
export const inngest = new Inngest({ id: "movie-ticket-booking" });

// Inngest Function to save user data to a database
const syncUserCreation = inngest.createFunction(
  { id: "sync-user-from-clerk" },
  { event: "clerk/user.created" },
  async ({ event }) => {
    const { id, first_name, last_name, email_addresses, image_url } =
      event.data;
    const userData = {
      _id: id,
      email: email_addresses[0].email_address,
      name: first_name + " " + last_name,
      image: image_url,
    };
    await User.create(userData);
  }
);

// Inngest function to delete user from database

const syncUserDeletion = inngest.createFunction(
  { id: "delete-user-with-clerk" },
  { event: "clerk/user.deleted" },

  async ({ event }) => {
    const { id } = event.data;
    await User.findByIdAndDelete(id);
  }
);

// Inngest function to update user data in database
const syncUserUpdation = inngest.createFunction(
  { id: "update-user-from-clerk" },
  { event: "clerk/user.updated" },
  async ({ event }) => {
    const { id, first_name, last_name, email_addresses, image_url } =
      event.data;
    const userData = {
      _id: id,
      email: email_addresses[0].email_address,
      name: first_name + " " + last_name,
      image: image_url,
    };
    await User.findByIdAndUpdate(id, userData);
  }
);

// Inngest function to cancel booking and release seats of show after 10 mins of booking created if payment is not made
const releaseSeatsAndDeleteBooking = inngest.createFunction(
  { id: "release-seats-delete-booking" },
  { event: "app/checkpayment" },
  async ({ event, step }) => {
    const tenMinutesLater = new Date(Date.now() + 10 * 60 * 1000);
    await step.sleepUntil("wait-for-10-minutes", tenMinutesLater);
    await step.run("check-payment-status", async () => {
      const bookingId = event.data.bookingId;
      const booking = await Booking.findById(bookingId);

      // if payment is not made, release seats and delete bookings
      if (!booking.isPaid) {
        const show = await Show.findById(booking.show);
        booking.bookedSeats.forEach((seat) => {
          delete show.occupiedSeats[seat];
        });
        show.markModified("occupiedSeats");
        await show.save();
        await Booking.findByIdAndDelete(booking._id);
      }
    });
  }
);

// Inngest function to send email when user books a show
const sendBookingConfirmationEmail = inngest.createFunction(
  { id: "send-booking-confirmation-email" },
  { event: "app/show.booked" },
  async ({ event, step }) => {
    const { bookingId } = event.data;
    const booking = await Booking.findById(bookingId)
      .populate({
        path: "show",
        populate: {
          path: "movie",
          model: "Movie",
        },
      })
      .populate("user");

    await sendEmail({
      to: booking.user.email,
      subject: `Payment Confirmation: "${booking.show.movie.title}" booked!`,
      body: ` <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
                <h2 style="color: #e50914;">🎟️ Movie Booking Confirmed!</h2>
                <p>Hi <strong>${booking.user.name}</strong>,</p>
                <p>Your booking has been confirmed. Here are the details:</p>

              <h3>${booking.show.movie.title}</h3>
             <p><strong>Show Time:</strong> ${new Date(
                  booking.show.showDateTime
              ).toLocaleString()}</p>
             <p><strong>Seats:</strong> ${booking.bookedSeats.join(", ")}</p>
             <p><strong>Total Paid:</strong> ₹${booking.amount}</p>
    
             <a href="https://yourdomain.com/my-bookings" style="display:inline-block;margin-top:20px;padding:12px 20px;background-color:#e50914;color:white;text-decoration:none;border-radius:6px;">
                 View My Booking
             </a>
             <p>Enjoy the show!</p>
             <p>Thanks for booking with us</p>
             <br />
             <p style="font-size:12px;color:#999;margin-top:40px;">© ${new Date().getFullYear()}Quickshow.</p>
           </div>`,
    });
  }
);

// Inngest function to send reminders
const sendShowReminders = inngest.createFunction(
  {id: "send-show-reminders"},
  {cron: "0 */8 * * *" }, // Every 8 hours
  async ({step})=>{
       const now = new Date()
       const in8Hours = new Date(now.getTime()+8*60*60*1000)
       const windowStart = new Date(in8Hours.getTime()-10*60*1000)
      // Prepare reminder tasks
       const reminderTasks = await step.run("prepare-reminder-tasks",async ()=>{
        const shows = await Show.find({
          showTime: {$gte: windowStart, $lte: in8Hours}
        }).populate('movie')
        const tasks = []
        for(const show of shows){
          if(!show.movie || !show.occupiedSeats) continue;

          const userIds = [...new Set(Object.values(show.occupiedSeats))]

          if(userIds.length === 0) continue;

          const users = await User.find({_id: {$in: userIds}}).select("name email")

          for(const user of users){
            tasks.push({
              userEmail: user.email,
              userName: user.name,
              movieTitle: show.movie.title,
              showTime: show.showTime
            })
          }
        }
        return tasks;
       })
       if(reminderTasks.length===0){
        return {sent: 0,message: "No reminders to send"}
       }
      //  Send reminder emails
      const results = await step.run('send-all-reminders',async ()=>{
        return await Promise.allSettled(
          reminderTasks.map(task=> sendEmail({
            to: task.userEmail,
            subject: `Reminder: Your movie "${task.movieTitle}" starts soon!`,
            body: `
                   <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
      <h2 style="color: #e50914;">🍿 Movie Reminder</h2>
      
      <p>Hi <strong>${task.userName}</strong>,</p>
      <p>This is a friendly reminder that your movie is scheduled soon. Here are the details:</p>

      <h3>${task.movieTitle}</h3>
      <p><strong>Show Time:</strong> ${new Date(task.showTime).toLocaleString()}</p>

      <div style="margin-top: 20px;">
        <a href="https://yourdomain.com/my-bookings" style="display:inline-block;padding:12px 20px;background-color:#e50914;color:white;text-decoration:none;border-radius:6px;">
          View Booking Details
        </a>
      </div>
      <p>It starts in approximately <strong>8 hours</strong></p>
      <p style="margin-top: 30px;">Make sure to arrive on time and enjoy your show!</p>

      <p style="font-size:12px;color:#999;margin-top:40px;">© ${new Date().getFullYear()} QuickShow.</p>
    </div>
                  `
          }))
        )
      })
      const sent = results.filter(r=> r.status==="fulfilled").length;
      const failed = results.length-sent;
      return {
        sent,
        failed,
        message: `Sent ${sent} reminders, ${failed} failed.`
      }
  }
)

// Inngest function to send notification when a new show is added
const sendNewShowNotifications = inngest.createFunction(
  {id: "send-new-show-notifications"},
  {event: "app/show.added"},
  async({event})=>{
    const {movieTitle, movieId} = event.data
    const users = await User.find({})
    for(const user of users){
      const userEmail = user.email;
      const userName = user.name;
      const subject = `📽 New Show Added: ${movieTitle}`;
      const body = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
          <h2 style="color: #e50914;">🎬 A New Show Just Dropped!</h2>

          <p>Hi <strong>${userName}</strong>,</p>
          <p>We're excited to announce that a new show for <strong>${movieTitle}</strong> has just been added to QuickShow!</p>

          <p>Don't miss the chance to book your seats early and enjoy the experience on the big screen.</p>

          <a href="https://yourdomain.com/movies/${movieId}" 
             style="display:inline-block;margin-top:20px;padding:12px 20px;background-color:#e50914;color:white;text-decoration:none;border-radius:6px;">
             Book Tickets Now
          </a>

          <p style="margin-top: 30px;">See you at the movies! 🍿</p>

          <p style="font-size:12px;color:#999;margin-top:40px;">© ${new Date().getFullYear()} QuickShow.</p>
        </div>
      `;

      await sendEmail({
        to: userEmail,
        subject,
        body,
      });
    }
    return {message: "Notifications sent."}
  }
)

// Create an empty array where we'll export Inngest functions
export const functions = [
  syncUserCreation,
  syncUserDeletion,
  syncUserUpdation,
  releaseSeatsAndDeleteBooking, 
  sendBookingConfirmationEmail,
  sendShowReminders,
  sendNewShowNotifications
];
