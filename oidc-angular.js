﻿'use strict';

(function() {

var eventPrefix = 'oidcauth:';

var unauthorizedEvent =          eventPrefix + 'unauthorized';
var tokenExpiredEvent =          eventPrefix + 'tokenExpired';
var tokenMissingEvent =          eventPrefix + 'tokenMissing';
var tokenExpiresSoonEvent =      eventPrefix + 'tokenExpires';

var loggedInEvent =              eventPrefix + 'loggedIn';
var loggedOutEvent =             eventPrefix + 'loggedOut';

var silentRefreshStartedEvent =     eventPrefix + 'silentRefreshStarted';
var silentInitRefreshStartedEvent = eventPrefix + 'silentInitRefreshStarted';
var silentRefreshSucceededEvent =   eventPrefix + 'silentRefreshSucceeded';
var silentRefreshFailedEvent =      eventPrefix + 'silentRefreshFailed';
var silentRefreshTimeoutEvent =     eventPrefix + 'silentRefreshTimeout';

// Module registration
var oidcmodule = angular.module('oidc-angular', ['base64', 'ngStorage', 'ui.router']);

oidcmodule.config(['$httpProvider', '$stateProvider', function($httpProvider, $stateProvider) {
    $httpProvider.interceptors.push('oidcHttpInterceptor');
    
    // Register callback route
    $stateProvider.state({
        name : 'authcallback',
        url: '/auth/callback/:data',
        template: '',
        controller: ['$auth', '$stateParams', function ($auth, $stateParams) {
            console.debug('oidc-angular: handling login-callback');
            $auth.handleSignInCallback($stateParams.data);
        }]
    }).state({
        name: 'authclear',
        url: '/auth/clear',
        template: '',
        controller: ['$auth', function ($auth) {
            console.debug('oidc-angular: handling logout-callback');
            $auth.handleSignOutCallback();
        }]
    });
        
    console.debug('oidc-angular: callback routes registered.')
}]);

oidcmodule.factory('oidcHttpInterceptor', ['$rootScope', '$q', '$auth', 'tokenService', function($rootScope, $q, $auth, tokenService) {
      return {

        'request': function(request) {
          
         if (request.url.startsWith($auth.config.apiUrl)) {
              
              var appendBearer = false;
              
              if($auth.config.enableRequestChecks) {
                  // Only append token when it's valid.
                  if (tokenService.hasToken()) {
                      if (tokenService.hasValidToken())
                      {
                          appendBearer = true;
                      }
                      else {
                          $rootScope.$broadcast(tokenExpiredEvent, { request: request });
                      }                  
                  }
                  else {
                      $rootScope.$broadcast(tokenMissingEvent, { request: request });
                  }
              }
              else {
                  appendBearer = tokenService.hasToken();
              }
              
              if (appendBearer) {
                  var token = tokenService.getIdToken();
                  request.headers['Authorization'] = 'Bearer ' + token;
              }
          }
          
          // do something on success
          return request;
        },
    
        'response': function(response) {
            // Proactively check if the token will expire soon
            $auth.validateExpirity();

            return response;
        },
          
        'responseError': function(response) {
            
            if (response.status == 401) {
              if (!tokenService.hasToken()) {
                  // There was probably no token attached, because there is none
                  $rootScope.$broadcast(tokenMissingEvent, { response: response });
              }
              else if (!tokenService.hasValidToken()) {
                  // Seems the token is not valid anymore
                  $rootScope.$broadcast(tokenExpiredEvent, { response: response });
              }
              else {
                  // any other
                  $rootScope.$broadcast(unauthorizedEvent, { response: response });
              }                  
            }
            
            return $q.reject(response);
          }
      };
    }]);

oidcmodule.service('tokenService', ['$base64', '$localStorage', function ($base64, $localStorage) {

    var service = this;

    var sanitize = function (base64data) {
        
        // Pad length to comply with the standard
        while (base64data.length % 4 !== 0) {
            base64data += "=";
        }

        // convert to base64 from base64url
        base64data = base64data.replace('_', '/');
        base64data = base64data.replace('-', '+');
        
        return base64data;
    };
    
    service.getPayloadFromRawToken = function(raw)
    {
        var tokenParts = raw.split(".");
        return tokenParts[1];
    };

    service.deserializeClaims = function(raw) {
        var claimsBase64 = sanitize(raw);
        var claimsJson = $base64.decode(claimsBase64);

        var claims = JSON.parse(claimsJson);

        return claims;
    };
    
    service.convertToClaims = function(id_token) {
        var payload = service.getPayloadFromRawToken(id_token);
        var claims = service.deserializeClaims(payload);

        return claims;
    };
    
    service.saveToken = function (id_token) {
        service.clearTokens();
        $localStorage['idToken'] =  id_token;

        var idClaims = service.convertToClaims(id_token);
        $localStorage['cached-claims'] =  idClaims;
        $localStorage.$apply();
    };

    service.hasToken = function() {
        
        var claims = service.allClaims();
        
        if (!(claims && claims.hasOwnProperty("iat") && claims.hasOwnProperty('exp'))) {
            return false;
        }
        
        return true;
    };
    
    service.hasValidToken = function() {
        if (!this.hasToken()) return false;
        
        var claims = service.allClaims();
        
        var now = Date.now();
        var issuedAtMSec = claims.iat * 1000;
        var expiresAtMSec = claims.exp * 1000;
        var marginMSec = 1000 * 60 * 5; // 5 Minutes
        
        // Subtract margin, because browser time could be a bit in the past
        if (issuedAtMSec - marginMSec > now) {
            console.log('oidc-connect: Token is not yet valid!')
            return false
        }
        
        if (expiresAtMSec < now) {
            console.log('oidc-connect: Token has expired!')
            return false;
        }
        
        return true;
    }

    service.allClaims = function() {
        var cachedClaims = $localStorage['cached-claims'];
        
        if (!cachedClaims) {
            var id_token = service.getIdToken();
            
            if (id_token) {
                cachedClaims = service.convertToClaims(id_token);
                $localStorage['cached-claims'] = cachedClaims;
            }
        }
        
        return cachedClaims;
    };
    
    service.getIdToken = function() {
        if ($localStorage['refreshRunning']) {
            $localStorage.$sync();
        }
        return $localStorage['idToken'];
    };
    
    service.clearTokens = function() {
        $localStorage['cached-claims'] = false;
        $localStorage['idToken'] = false;
    }
}]);

oidcmodule.provider("$auth", ['$stateProvider', '$windowProvider', '$locationProvider', function ($stateProvider, $windowProvider, $locationProvider) {

    var window = $windowProvider.$get();
    var prefix = $locationProvider.hashPrefix();
    // Default configuration
    var config = {
        basePath: null,
        clientId: null,
        apiUrl: '/api/',
        responseType: 'id_token',
        scope: "openid profile",
        redirectUri: (window.location.origin || window.location.protocol + '//' + window.location.host) + window.location.pathname + '#' + prefix + '/auth/callback/',
        logoutUri: (window.location.origin || window.location.protocol + '//' + window.location.host) + window.location.pathname + '#' + prefix + '/auth/clear',
        state: "",
        authorizationEndpoint:  'connect/authorize',
        revocationEndpoint:     'connect/revocation', 
        endSessionEndpoint:     'connect/endsession',
        advanceRefresh:         300,
        enableRequestChecks:    false,
        stickToLastKnownIdp:    false
      };

    return {
     
        // Service configuration
        configure: function (params) {
            angular.extend(config, params);
        },
        
        // Service itself
        $get: ['$timeout', '$q', '$document', '$rootScope', '$localStorage', '$location', 'tokenService', function ($timeout, $q, $document, $rootScope, $localStorage, $location, tokenService) {
        
            var init = function() {
                
                if ($localStorage['logoutActive']) {
                    delete $localStorage['logoutActive'];
                    tokenService.clearTokens();                    
                }
                if ($localStorage['refreshRunning']) {
                    delete $localStorage['refreshRunning'];
                }
                if ($localStorage['validateExpirityLoopRunning']) {
                    delete $localStorage['validateExpirityLoopRunning'];
                }
                if(window === window.parent && config.advanceRefresh) {
                    if (tokenService.hasToken()) {
                        if (!tokenService.hasValidToken()) {
                            $rootScope.$broadcast(silentInitRefreshStartedEvent);
                            trySilentRefresh();
                        } else {
                            validateExpirityLoop();
                        }
                    }
                }
            };

            var validateExpirityLoop = function(){
                if($localStorage['validateExpirityLoopRunning']) {
                    return;
                }
                $localStorage['validateExpirityLoopRunning'] = true;
                var f = function() {
                    if(!$localStorage['validateExpirityLoopRunning']) {
                        return;
                    }
                    validateExpirity();
                    $timeout(f, config.advanceRefresh);
                };
                f();
            };
            
            var createLoginUrl = function (nonce, state) {
            
                var hasPathDelimiter = config.basePath.endsWith('/');
                var appendChar = (hasPathDelimiter) ? '' : '/';
                
                var currentClaims = tokenService.allClaims();
                if (currentClaims) {
                    var idpClaimValue = currentClaims["idp"];
                }

                var baseUrl = config.basePath + appendChar;
                var url = baseUrl + config.authorizationEndpoint
                                  + "?response_type="
                                  + encodeURIComponent(config.responseType)
                                  + "&client_id=" 
                                  + encodeURIComponent(config.clientId) 
                                  + "&state=" 
                                  + encodeURIComponent(state || config.state) 
                                  + "&redirect_uri=" 
                                  + encodeURIComponent(config.redirectUri) 
                                  + "&scope=" 
                                  + encodeURIComponent(config.scope)
                                  + "&nonce=" 
                                   + encodeURIComponent(nonce);

                if (config.stickToLastKnownIdp && idpClaimValue) {
                    url = url + "&acr_values="
                              + encodeURIComponent("idp:" + idpClaimValue);
                }

                return url;
            };

            var createLogoutUrl = function(state) {
                
                var idToken = tokenService.getIdToken();
                
                var hasPathDelimiter = config.basePath.endsWith('/');
                var appendChar = (hasPathDelimiter) ? '' : '/';
                
                var baseUrl = config.basePath + appendChar;
                var url = baseUrl + config.endSessionEndpoint
                                  + "?id_token_hint="
                                  + encodeURIComponent(idToken)
                                  + "&post_logout_redirect_uri=" 
                                  + encodeURIComponent(config.logoutUri) 
                                  + "&state=" 
                                  + encodeURIComponent(state || config.state) 
                                  + "&r=" + Math.random();
                return url;
            }    
            
            var startImplicitFlow = function (localRedirect) {
            
                $localStorage['localRedirect'] = localRedirect;
                
                var url = createLoginUrl("dummynonce");
                window.location.replace(url);
            };
    
            var startLogout = function () {
                var url = createLogoutUrl();
                $localStorage['logoutActive'] = true;
                $localStorage['validateExpirityLoopRunning'] = false;
                $localStorage.$apply();

                $timeout(function(){ window.location.replace(url); }, 100);
            };

            var handleImplicitFlowCallback = function(id_token) {
                
                tokenService.saveToken(id_token);
        
                var localRedirect = $localStorage['localRedirect'];
                
                if (localRedirect) {
                    var redirectTo = localRedirect.hash.substring(1);
                    delete $localStorage['localRedirect'];
                    $location.path(redirectTo);
                }
                else {
                    $location.path('/');
                }
                if(tokenService.hasValidToken()) {
                    validateExpirityLoop();
                }
                
                $rootScope.$broadcast(loggedInEvent);      
                return true;      
            };

            var handleSilentRefreshCallback = function(newIdToken) {
                
                delete $localStorage['refreshRunning'];
                
                var currentClaims = tokenService.allClaims();
                var event;
                var newClaims = tokenService.convertToClaims(newIdToken);
                
                if (!currentClaims || (currentClaims.exp && newClaims.exp && newClaims.exp > currentClaims.exp)) {
                    tokenService.saveToken(newIdToken);
                    event = silentRefreshSucceededEvent;
                }
                else {
                    event = silentRefreshFailedEvent;
                }
                $localStorage['refreshRunning'] = false;
                $localStorage.$apply();
                $rootScope.$broadcast(event);
            };

            var trySilentRefresh = function() {
                
                if ($localStorage['refreshRunning']) {
                    return;
                }
                
                $localStorage['refreshRunning'] = true;
                $localStorage.$apply();

                $timeout(function(){
                    $rootScope.$broadcast(silentRefreshStartedEvent);

                    var url = createLoginUrl('dummynonce', 'refresh');

                    var html = "<iframe src='" + url + "' height='400' width='100%' id='oauthFrame' style='display:none;visibility:hidden;'></iframe>";
                    var elem = angular.element(html);

                    $document.find("body").append(elem);

                    $timeout(function() {
                        $localStorage.$sync();
                        if ($localStorage['refreshRunning']) {
                            $rootScope.$broadcast(silentRefreshTimeoutEvent);
                            delete $localStorage['refreshRunning']
                        }

                        if (tokenService.hasValidToken()) {
                            validateExpirityLoop();
                        }
                        $document.find("#oauthFrame").remove();
                    }, 30000);
                }, 5000);
            };


            var handleSignInCallback = function(data) {
                
                if (!data && window.location.hash.indexOf("#") === 0) {
                    data = window.location.hash.substr(16)
                }
                                
                var fragments = {}
                if (data) {
                    fragments = parseQueryString(data);
                }
                else {
                    throw Error("Unable to process callback. No data given!");
                }
            
                console.debug("oidc-angular: Processing callback information", data);
            
                var id_token     = fragments['id_token'];
                var state        = fragments['state'];
                
                if (id_token) {
                    if (state === 'refresh') {
                        handleSilentRefreshCallback(id_token);
                    }
                    else {
                        handleImplicitFlowCallback(id_token);
                    }               
                }
            };

            var handleSignOutCallback = function() {

                delete $localStorage['logoutActive'];
                delete $localStorage['validateExpirityLoopRunning'];
                
                tokenService.clearTokens();
                $location.path('/');

                $rootScope.$broadcast(loggedOutEvent);            
            };
            
            var tokenIsValidAt = function(date) {
                var claims = tokenService.allClaims();

                if (!claims || !(claims.hasOwnProperty('exp'))) {
                    return false;
                }

                var expiresAtMSec = claims.exp * 1000;
                                
                if (date <= expiresAtMSec) {
                    return true;
                }
                
                return false;
            }
            
            var validateExpirity = function() {
                var now = Date.now();
            
                if (!tokenService.hasValidToken() || !tokenIsValidAt(now + config.advanceRefresh)) {
                    $rootScope.$broadcast(tokenExpiresSoonEvent);
                    trySilentRefresh();
                }
            };

            init();

            return {
                config: config,
            
                handleSignInCallback : handleSignInCallback,
            
                handleSignOutCallback : handleSignOutCallback,
            
                validateExpirity: validateExpirity,
            
                isAuthenticated : function() { 
                    return tokenService.hasValidToken(); 
                },
            
                isAuthenticatedIn : function(milliseconds) { 
                    return tokenService.hasValidToken() && tokenIsValidAt(new Date().getTime() + milliseconds); 
                },
            
                signIn : function(localRedirect) { 
                    startImplicitFlow(localRedirect);
                },
            
                signOut : function() {
                    startLogout();
                },
                
                silentRefresh : function() {
                    trySilentRefresh();
                }
              
            };
        }]
    };
}]);

/* Helpers & Polyfills */
function parseQueryString(queryString) {
    var data = {}, pairs, pair, separatorIndex, escapedKey, escapedValue, key, value;

    if (queryString === null) {
        return data;
    }

    pairs = queryString.split("&");

    for (var i = 0; i < pairs.length; i++) {
        pair = pairs[i];
        separatorIndex = pair.indexOf("=");

        if (separatorIndex === -1) {
            escapedKey = pair;
            escapedValue = null;
        } else {
            escapedKey = pair.substr(0, separatorIndex);
            escapedValue = pair.substr(separatorIndex + 1);
        }

        key = decodeURIComponent(escapedKey);
        value = decodeURIComponent(escapedValue);

        if (key.substr(0, 1) === '/')
            key = key.substr(1);

        data[key] = value;
    }

    return data;
 }
 
     
if (!String.prototype.endsWith) {
    String.prototype.endsWith = function (searchString, position) {
        var subjectString = this.toString();
        if (position === undefined || position > subjectString.length) {
            position = subjectString.length;
        }
        position -= searchString.length;
        var lastIndex = subjectString.indexOf(searchString, position);
        return lastIndex !== -1 && lastIndex === position;
    };
}

if (!String.prototype.startsWith) {
  String.prototype.startsWith = function(searchString, position) {
    position = position || 0;
    return this.lastIndexOf(searchString, position) === position;
  };
}

})();
