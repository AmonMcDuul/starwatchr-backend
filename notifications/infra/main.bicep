targetScope = 'resourceGroup'

@description('A globally unique Function App name.')
param functionAppName string
param location string = resourceGroup().location
@description('Exact HTTPS origin of the frontend, without a trailing slash.')
param siteUrl string
@secure()
@minLength(32)
param tokenSecret string
@secure()
@minLength(32)
param adminKey string
@secure()
@description('MAIL_SERVICE_URL, MAIL_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT and NOTIFICATIONS_ANALYTICS_KEY app settings.')
param deliverySettings object = {}
@allowed(['dry-run', 'live'])
param notificationMode string = 'dry-run'
@description('Exact HTTPS origin of the analytics dashboard.')
param analyticsOrigin string = 'https://sw-analytics.netlify.app'

var storageName = 'swn${uniqueString(resourceGroup().id, functionAppName)}'
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource packages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${functionAppName}-plan'
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: { reserved: true }
}
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${functionAppName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${functionAppName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}
var storageConnection = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
resource worker 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 512
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${packages.name}'
          authentication: {
            type: 'StorageAccountConnectionString'
            storageAccountConnectionStringName: 'AzureWebJobsStorage'
          }
        }
      }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      cors: {
        allowedOrigins: [siteUrl, analyticsOrigin]
        supportCredentials: false
      }
    }
  }
}
resource settings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: worker
  name: 'appsettings'
  properties: union(deliverySettings, {
    AzureWebJobsStorage: storageConnection
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    SITE_URL: siteUrl
    NOTIFICATIONS_API_URL: 'https://${worker.properties.defaultHostName}/api'
    TOKEN_SECRET: tokenSecret
    NOTIFICATIONS_ADMIN_KEY: adminKey
    NOTIFICATION_MODE: notificationMode
  })
}
output functionName string = worker.name
output apiBaseUrl string = 'https://${worker.properties.defaultHostName}/api'
output storageAccountName string = storage.name
