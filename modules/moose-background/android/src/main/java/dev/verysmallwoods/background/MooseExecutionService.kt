package dev.verysmallwoods.background

import android.app.*
import android.Manifest
import android.content.pm.PackageManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.kotlin.Promise

/** Uses the existing ReactContext only: never constructs another ReactHost or Harness. */
class MooseExecutionService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var token: String? = null
  private var task: Int? = null
  private var context: ReactContext? = null
  private var lock: PowerManager.WakeLock? = null
  private var stopping = false
  private var notification: NotificationCompat.Builder? = null
  private val budget = Runnable { cancel("budget_expired") }
  private val handshake = Runnable { cancel("handshake_timeout") }
  private val unresponsive = Runnable {
    // Persisted cancellation is handled before recovery on next explicit launch.
    shutdown()
    android.os.Process.killProcess(android.os.Process.myPid())
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() { super.onCreate(); instance = this }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      if (token != null && intent.getStringExtra("token") == token) cancel("notification_stop")
      else if (token == null && admission == null) shutdown()
      return START_NOT_STICKY
    }
    val requested = intent?.getStringExtra("token")
    val pending = admission
    if (requested == null || pending == null || pending.token != requested || stopping) {
      // A stale Intent must not stop a newer admission waiting for onStartCommand.
      if (token == null && pending == null) shutdown()
      return START_NOT_STICKY
    }
    try {
      check(token == null) { "Execution service already active" }
      instance = this
      token = requested
      context = pending.context
      val manager = getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Background tasks", NotificationManager.IMPORTANCE_LOW))
        check(manager.getNotificationChannel(CHANNEL).importance != NotificationManager.IMPORTANCE_NONE) { "Enable background task notifications" }
      }
      val stop = PendingIntent.getService(this, 1,
        Intent(this, MooseExecutionService::class.java).setAction(ACTION_STOP).putExtra("token", requested),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      val notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("Moose is running tasks")
        .setContentText("Up to 30 minutes. Stop cancels all tasks.")
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setOngoing(true).setOnlyAlertOnce(true)
        .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
      if (launch != null) notification.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE))
      this.notification = notification
      ServiceCompat.startForeground(this, 7301, notification.build(),
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
      lock = (getSystemService(POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Moose:finite-execution")
        .apply { setReferenceCounted(false); acquire(BUDGET + 15000) }
      handler.postDelayed(budget, BUDGET)
      handler.postDelayed(handshake, 15000)
      val data = Arguments.createMap().apply { putString("token", requested) }
      task = HeadlessJsTaskContext.getInstance(pending.context)
        .startTask(HeadlessJsTaskConfig("MooseExecution", data, 0, true))
    } catch (error: Exception) {
      pending.promise.reject("BACKGROUND_START", "Could not start background execution", error)
      admission = null
      shutdown()
    }
    return START_NOT_STICKY
  }
  fun waiting(value: Boolean) {
    handler.post {
      val builder = notification ?: return@post
      if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        cancel("notification_permission_lost")
        return@post
      }
      if (!stopping) getSystemService(NotificationManager::class.java).notify(7301,
        builder.setContentText(if (value) "Approval needed. Open Moose to continue." else "Up to 30 minutes. Stop cancels all tasks.").build())
    }
  }
  fun ready(value: String) {
    handler.post {
      if (token == value && !stopping) {
        handler.removeCallbacks(handshake)
        admission?.takeIf { it.token == value }?.promise?.resolve(null)
        admission = null
      }
    }
  }
  fun release(value: String) {
    if (token == value && !stopping) shutdown()
  }
  fun runtimeDestroyed() { handler.post { cancel("runtime_destroyed") } }
  private fun cancel(reason: String) {
    if (stopping) return
    stopping = true
    persistStop(this, reason)
    admission?.promise?.reject("BACKGROUND_STOP", "Background execution stopped", null)
    admission = null
    emitStop?.invoke()
    handler.postDelayed(unresponsive, 10000)
  }
  fun acknowledgeStop() { handler.post { if (stopping) shutdown() } }
  private fun shutdown() {
    handler.removeCallbacksAndMessages(null)
    task?.let { id -> context?.let { HeadlessJsTaskContext.getInstance(it).finishTask(id) } }
    task = null
    token = null
    context = null
    notification = null
    if (lock?.isHeld == true) lock?.release()
    lock = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
    if (instance === this) instance = null
  }
  override fun onDestroy() {
    // Unexpected service removal must cancel JS; a normal release already cleared instance.
    if (instance === this) {
      persistStop(this, "service_destroyed")
      emitStop?.invoke()
    }
    shutdown()
    super.onDestroy()
  }
  companion object {
    private const val CHANNEL = "moose-execution"
    private const val PREFS = "moose-execution-control"
    private const val ACTION_STOP = "dev.verysmallwoods.moose.STOP_EXECUTION"
    private const val BUDGET = 30L * 60 * 1000
    private data class Admission(val token: String, val context: ReactContext, val promise: Promise)
    private var admission: Admission? = null
    var instance: MooseExecutionService? = null
      private set
    var emitStop: (() -> Unit)? = null
    fun request(context: ReactContext, token: String, promise: Promise) {
      check(admission == null && instance == null) { "Background service is busy" }
      admission = Admission(token, context, promise)
      try {
        ContextCompat.startForegroundService(context, Intent(context, MooseExecutionService::class.java).putExtra("token", token))
      } catch (error: Exception) { admission = null; throw error }
    }
    fun releaseRequest(token: String) {
      admission?.takeIf { it.token == token }?.let {
        it.promise.reject("BACKGROUND_STOP", "Background execution stopped", null)
        admission = null
      }
      instance?.release(token)
    }
    private fun persistStop(context: Context, reason: String) {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      // Preserve the first cause if onDestroy follows budget/user/runtime cancellation.
      if (!prefs.getBoolean("stop", false)) prefs.edit()
        .putBoolean("stop", true).putString("reason", reason)
        .putLong("at", System.currentTimeMillis()).commit()
    }
    fun stopDetail(context: Context): Map<String, Any>? {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (!prefs.getBoolean("stop", false)) return null
      return mapOf("reason" to (prefs.getString("reason", null) ?: "native_stop_unknown"), "at" to prefs.getLong("at", System.currentTimeMillis()).toDouble())
    }
    fun pendingStop(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("stop", false)
    fun clearStop(context: Context) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("stop").remove("reason").remove("at").commit() }
  }
}
