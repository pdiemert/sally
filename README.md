#Sally#
A tool that distributes [SSA](https://github.com/pdiemert/ssa) suites to a cluster in order to test load using node.js

Install:

	npm install sally -g
	
(note: libzmq is used for communication.  See [ZeroMQ](http://http://www.zeromq.org/) for reference.)

When sally is run without a suite it assumed to be a *slave*.  Any number of slaves can be run, pass the host name of the master:

	> sally -m localhost
	Running as a slave to localhost, up port 12346, down port 12347

(note that if -m localhost is omitted it will be assumed)	

Run the master as an app. that calls runLoad():

	> node loadtest.js
	..Load Testing..
	
When sally starts it will search for available slaves before starting the load test.  There must be at least one slave available.  After the test is run the slave will go back into *wait* mode for the next test.


An example load test that creates a single virtual user to make an http request (localhost:1337) every 500ms for a period of 5s:

	require('sally').runLoad({

		users: {
			reader:[
				{
					test: 'root request',
					get: '/',
					expect : function(data, headers, code)
					{
						this.assert.equal(data, 'Hello World');
					}
				}
			]
		}
	}
	, {
		duration: 5,
		loadProfile:{
			'reader':[
				[0, 1]  // One reader for duration
			]
		},
		repeatDelay: 500,
		host: 'localhost',
		port: 1337,
		dumpLog: 'onfail'
	});
	

Sally exposes a single function:

    runLoad(loadtest, options)

Load tests consist of an object with the following properties:

    {
        // SSA Suite to run first (optional)
        start: [],

        // Virtual users
        users:
        {
            // Object of virtual users, each item is "<name>" : [<SSA suite>]
        },

       // SSA Suite to run last (optional)
       finish: []
	}

The general pattern for load tests is to use the start suite to set up whatever variables you need for the load test and store the results in `this.params`.  The params are then passed to virtual users which are created during the test.  In addition to asserts and information added to `this.log` is merged together from all virtual users at the end of the test and passed to the finish suite.

All suite functions are passed the following on the this.loadTest object:
####userIndex
The index of this user within the population of running users (not sent to start/finish)  |
####userCount
Total number of users, of this type, in the population (not sent to start/finish)
####runCount
The total number of times this user suite has been run (not sent to start/finish)
####getUserCount
A function that returns the user count for a user name
####params
An object which should be used during start to set properties which will be passed to all users
####workerId
An id for the worker processes, every SLAVE has a unique worker id  
####clock
An object containing the merge of all clocks.  Use the 'clock' property on each user suite to retrieve timings.
This object will have {clockname:{count:,elapsed:,avg:} // all times in ms

##Options##
An object that can have similar properties to SSA with the additional:

####params
Parameters sent to all suites context
####verbosity
Verbosity level, each higher level will include all lower level messages, can be:

*	0   No messages, just show errors and summary  
*	1   All test results
*	2   All info messages
*	3   All request/responses

####duration
Duration of test in seconds
####loadProfile
Can be either:

1. An array -  Each item is a two element array, first is a time offset in seconds, second is a user count. The user count is divided evenly among the different virtual users.  For example:

	[[0,10],[120,1000]]
	Starts with 10 users at the beginning of the test and ramps to 1000 after 120 seconds
	
2. An object - Each property name corresponds to a virtual user name, each value is a two element array of offset, user count as above.

####repeatDelay
Can be either a number which will be the number of milliseconds between suite execution for all users or an object with each property a user name and each value the number of millisecond delay for those users. If no repeat delay then a default 1000ms is used.

####dumpLog
If true, will dump contents of combined log after load test. If "onfail" then will dump only on failure.

####spindown
Number of seconds to wait at the end of the test for any open connections to close.  Default is 60.

All logs are merged before finish is called

