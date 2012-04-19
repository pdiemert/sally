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
			'reader':
			[
				[0, 1]  // One reader for duration
			]
		},
		repeatDelay:{
			reader:100
		},
		host: 'localhost',
		port: 1337,
		dumpLog: 'onfail'
	});