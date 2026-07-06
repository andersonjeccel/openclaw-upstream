package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class SecurePrefsTest {
  private fun testPrefs(context: android.app.Application): SecurePrefs =
    SecurePrefs(
      context,
      context.getSharedPreferences("secure-prefs-test-${UUID.randomUUID()}", Context.MODE_PRIVATE),
    )

  @Test
  fun loadLocationMode_migratesLegacyAlwaysValue() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putString("location.enabledMode", "always")
      .commit()

    val prefs = testPrefs(context)

    assertEquals(LocationMode.WhileUsing, prefs.locationMode.value)
    assertEquals("whileUsing", plainPrefs.getString("location.enabledMode", null))
  }

  @Test
  fun voiceMicEnabled_ignoresOldTalkEnabledKey() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("talk.enabled", true)
      .commit()

    val prefs = testPrefs(context)

    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(plainPrefs.contains("voice.micEnabled"))
  }

  @Test
  fun setVoiceMicEnabled_persistsNewKeyOnly() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putBoolean("talk.enabled", false)
      .commit()
    val prefs = testPrefs(context)

    prefs.setVoiceMicEnabled(true)

    assertTrue(prefs.voiceMicEnabled.value)
    assertTrue(plainPrefs.getBoolean("voice.micEnabled", false))
    assertFalse(plainPrefs.getBoolean("talk.enabled", false))
  }

  @Test
  fun installedAppsSharing_defaultsOffAndPersistsOptIn() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertFalse(prefs.installedAppsSharingEnabled.value)

    prefs.setInstalledAppsSharingEnabled(true)

    assertTrue(prefs.installedAppsSharingEnabled.value)
    assertTrue(plainPrefs.getBoolean("device.apps.sharing.enabled", false))
  }

  @Test
  fun cameraSharing_defaultsOffAndPersistsOptIn() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertFalse(prefs.cameraEnabled.value)
    assertFalse(plainPrefs.getBoolean("camera.enabled", true))

    prefs.setCameraEnabled(true)

    assertTrue(prefs.cameraEnabled.value)
    assertTrue(plainPrefs.getBoolean("camera.enabled", false))
  }

  @Test
  fun cameraSharing_migratesExistingInstallsToPreviousDefault() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs
      .edit()
      .clear()
      .putString("node.instanceId", "existing-node")
      .commit()
    val prefs = testPrefs(context)

    assertTrue(prefs.cameraEnabled.value)
    assertTrue(plainPrefs.getBoolean("camera.enabled", false))
  }

  @Test
  fun appearanceThemeMode_defaultsDarkForExistingInstalls() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val prefs = testPrefs(context)

    assertEquals(AppearanceThemeMode.Dark, prefs.appearanceThemeMode.value)
    assertFalse(plainPrefs.contains("appearance.themeMode"))
  }

  @Test
  fun setAppearanceThemeMode_persistsSelectedMode() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().commit()
    val securePrefs = context.getSharedPreferences("secure-prefs-test-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, securePrefs)

    prefs.setAppearanceThemeMode(AppearanceThemeMode.Light)

    assertEquals(AppearanceThemeMode.Light, prefs.appearanceThemeMode.value)
    assertEquals("light", plainPrefs.getString("appearance.themeMode", null))
    assertEquals(AppearanceThemeMode.Light, SecurePrefs(context, securePrefs).appearanceThemeMode.value)
  }

  @Test
  fun gatewayCredentials_areIndependentAcrossGateways() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.saveGatewayCredentials("gateway-a", token = " shared-token ", bootstrapToken = "bootstrap-token")
    prefs.saveGatewayCredentials("gateway-b", password = "password-token")

    assertEquals(GatewayCredentials(token = "shared-token", bootstrapToken = "bootstrap-token"), prefs.loadGatewayCredentials("gateway-a"))
    assertEquals(GatewayCredentials(password = "password-token"), prefs.loadGatewayCredentials("gateway-b"))
  }

  @Test
  fun clearGatewayCredentials_removesOnlyTargetGateway() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.clear", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.saveGatewayCredentials("gateway-a", token = "shared-token", bootstrapToken = "bootstrap-token")
    prefs.saveGatewayCredentials("gateway-b", password = "password-token")

    prefs.clearGatewayCredentials("gateway-a")

    assertEquals(GatewayCredentials(), prefs.loadGatewayCredentials("gateway-a"))
    assertEquals(GatewayCredentials(password = "password-token"), prefs.loadGatewayCredentials("gateway-b"))
  }
}
