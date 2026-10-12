plugins {
    kotlin("jvm") version "2.4.20"
    application
}

group = "local.dota"
version = "0.0.0"

kotlin { jvmToolchain(21) }

application { mainClass.set("local.dota.parser.MainKt") }

dependencies {
    implementation("com.networknt:json-schema-validator:2.0.4")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.4")
}

sourceSets.main {
    resources.srcDir("../../packages/contracts/schema")
}

dependencyLocking { lockAllConfigurations() }
